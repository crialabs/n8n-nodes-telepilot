import 'reflect-metadata';
import { Service } from 'typedi';
import {IDataObject} from "n8n-workflow";
const { Client } = require('@telepilotco/tdl');
const tdl = require('@telepilotco/tdl');
// const childProcess = require('child_process');

const debug = require('debug')('telepilot-cm')

const fs = require('fs/promises');
const path = require('path');

var pjson = require('../../package.json');
const nodeVersion = pjson.version;

const binaryVersion = pjson.dependencies["@telepilotco/tdlib-binaries-prebuilt"].replace("^", "");
const addonVersion = pjson.dependencies["@telepilotco/tdl"].replace("^", "");

// Create a direct backup reference to the configure function
// This helps avoid issues with how n8n might be loading modules
const tdlConfigure = tdl.configure;

// Removed global state flags isInitialized, isConfigured
// Removed global getBinaryPaths function
// Removed global initializeTDLib function
// Removed global resetTDLib function (commented out)

export enum TelepilotAuthState {
	NO_CONNECTION = "NO_CONNECTION",
	WAIT_TDLIB_PARAMS = "authorizationStateWaitTdlibParameters",
	WAIT_ENCRYPTION_KEY = "authorizationStateWaitEncryptionKey",
	WAIT_PHONE_NUMBER = "authorizationStateWaitPhoneNumber",
	WAIT_CODE = "authorizationStateWaitCode",
	WAIT_DEVICE_CONFIRMATION = "authorizationStateWaitOtherDeviceConfirmation",
	WAIT_REGISTRATION = "authorizationStateWaitRegistration",
	WAIT_PASSWORD = "authorizationStateWaitPassword",
	WAIT_READY = "authorizationStateReady",
	WAIT_LOGGING_OUT = "authorizationStateLoggingOut",
	WAIT_CLOSING = "authorizationStateClosing",
	WAIT_CLOSED = "authorizationStateClosed"
}

// Define the session data structure for persistence
interface StoredSessionData {
	apiId: number;
	phoneNumber: string;
	authState: TelepilotAuthState;
	lastUsed: number;  // timestamp
}

function getEnumFromString(enumObj: any, str: string): any {
	for (const key in enumObj) {
		if (enumObj.hasOwnProperty(key) && enumObj[key] === str) {
			return enumObj[key];
		}
	}
	return undefined;
}

class ClientSession {
	client: typeof Client;
	authState: TelepilotAuthState;
	phoneNumber: string;

	constructor(client: typeof Client, authState: TelepilotAuthState, phoneNumber: string) {
		this.client = client;
		this.authState = authState;
		this.phoneNumber = phoneNumber
	}
}

export function sleep(ms: number) {
	return new Promise( resolve => setTimeout(resolve, ms) );
}

@Service()
export class TelePilotNodeConnectionManager {

	private clientSessions: Record<string, ClientSession> = {}; // Key is now `${apiId}:${phoneNumber}`
	private tdlConfigured: boolean = false; // Reintroduce class member flag
	private sessionsLoaded: boolean = false; // Flag to track if sessions have been loaded

	private TD_DATABASE_PATH_PREFIX = process.env.HOME + "/.n8n/nodes/node_modules/@inite/n8n-nodes-telepilot/db"
	private TD_FILES_PATH_PREFIX = process.env.HOME + "/.n8n/nodes/node_modules/@inite/n8n-nodes-telepilot/db"
	private SESSION_STATE_FILE = process.env.HOME + "/.n8n/nodes/node_modules/@inite/n8n-nodes-telepilot/sessions.json"

	constructor() {
		// Load persistent sessions on startup
		this.loadSessions();
	}

	// Helper method to generate a unique session key from apiId and phoneNumber
	private getSessionKey(apiId: number, phoneNumber: string): string {
		return `${apiId}:${phoneNumber}`;
	}

	// Save session data to persistent storage
	private async saveSessions() {
		try {
			// Create sessions directory if it doesn't exist
			const sessionsDir = path.dirname(this.SESSION_STATE_FILE);
			try {
				await fs.mkdir(sessionsDir, { recursive: true });
			} catch (err) {
				// Ignore directory already exists error
				debug(`Directory creation error (may already exist): ${err.message}`);
			}

			// Create a storable version of the sessions (without client objects)
			const sessions: Record<string, StoredSessionData> = {};

			for (const [key, session] of Object.entries(this.clientSessions)) {
				const [apiId, phoneNumber] = key.split(':');

				// Only persist sessions that are in READY state
				if (session.authState === TelepilotAuthState.WAIT_READY) {
					sessions[key] = {
						apiId: parseInt(apiId, 10),
						phoneNumber,
						authState: session.authState,
						lastUsed: Date.now()
					};
				}
			}

			// Write to file
			await fs.writeFile(this.SESSION_STATE_FILE, JSON.stringify(sessions, null, 2));
			debug(`Sessions saved to ${this.SESSION_STATE_FILE}`);
		} catch (err) {
			debug(`Error saving sessions: ${err.message}`);
		}
	}

	// Load session data from persistent storage
	private async loadSessions() {
		if (this.sessionsLoaded) {
			return; // Don't load sessions multiple times
		}

		try {
			// Check if sessions file exists
			try {
				await fs.access(this.SESSION_STATE_FILE);
			} catch (err) {
				debug(`No session file found at ${this.SESSION_STATE_FILE}`);
				this.sessionsLoaded = true;
				return;
			}

			// Read and parse sessions file
			const data = await fs.readFile(this.SESSION_STATE_FILE, 'utf8');
			const sessions = JSON.parse(data) as Record<string, StoredSessionData>;
			debug(`Loaded ${Object.keys(sessions).length} sessions from file`);

			// Nothing to do if no sessions
			if (Object.keys(sessions).length === 0) {
				this.sessionsLoaded = true;
				return;
			}

			// Create session entries for each loaded session
			for (const [key, sessionData] of Object.entries(sessions)) {
				// Only restore sessions that were in READY state
				if (sessionData.authState === TelepilotAuthState.WAIT_READY) {
					debug(`Found saved session for ${key}, will restore on demand`);
					// We don't create the client here, but mark that we have session data
					// The client will be created when needed in restoreSession
				}
			}

			debug('Loaded session data, will initialize connections as needed');
			this.sessionsLoaded = true;
		} catch (err) {
			debug(`Error loading sessions: ${err.message}`);
			this.sessionsLoaded = true;
		}
	}

	// Ensure sessions are loaded before any operation
	private async ensureSessionsLoaded() {
		if (!this.sessionsLoaded) {
			await this.loadSessions();
		}
	}

	// This method attempts to restore a session
	private async restoreSession(apiId: number, apiHash: string, phoneNumber: string) {
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		debug(`Attempting to restore session for ${sessionKey}`);

		// Initialize TDLib if not already done
		if (!this.tdlConfigured) {
			try {
				let {libFolder, libFile} = this.locateBinaryModules();
				debug(`Configuring TDLib with libdir: ${libFolder}, file: ${libFile}`);
				tdlConfigure({
					libdir: libFolder,
					tdjson: libFile
				});
				this.tdlConfigured = true;
				debug('TDLib configuration successful');
			} catch (e: any) {
				debug('Error during TDLib configuration attempt:', e.message);
				if (e.message && e.message.includes('already initialized')) {
					debug('TDLib was already configured elsewhere, marking as configured');
					this.tdlConfigured = true;
				} else {
					throw e;
				}
			}
		}

		// Create client - this will attempt to reuse existing TDLib database
		try {
			const client = tdl.createClient({
				apiId,
				apiHash,
				databaseDirectory: this.getTdDatabasePathForClient(apiId, phoneNumber),
				filesDirectory: this.getTdFilesPathForClient(apiId, phoneNumber),
				nodeVersion,
				binaryVersion,
				addonVersion
			});

			// Create and store session
			const session = new ClientSession(client, TelepilotAuthState.NO_CONNECTION, phoneNumber);
			this.clientSessions[sessionKey] = session;

			// Set up auth handler
			const authHandler = (update: IDataObject) => {
				if (update._ === "updateAuthorizationState") {
					debug('authHandler.Got updateAuthorizationState:', JSON.stringify(update, null, 2))
					const authorization_state = update.authorization_state as IDataObject;

					if (this.clientSessions[sessionKey] !== undefined) {
						this.clientSessions[sessionKey].authState = getEnumFromString(TelepilotAuthState, authorization_state._ as string);
						debug(`set clientSession ${sessionKey} authState to ` + this.clientSessions[sessionKey].authState);

						// If we reach WAIT_READY state, save sessions
						if (this.clientSessions[sessionKey].authState === TelepilotAuthState.WAIT_READY) {
							this.saveSessions();
						}
					}
				}
			};

			// Register auth handler
			client.on('update', authHandler);

			return true;
		} catch (err) {
			debug(`Failed to restore session for ${sessionKey}: ${err.message}`);
			return false;
		}
	}

	async closeLocalSession(apiId: number, phoneNumber: string) {
		debug("closeLocalSession apiId:" + apiId + ", phoneNumber:" + phoneNumber);
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		let clients_keys = Object.keys(this.clientSessions);
		if (!clients_keys.includes(sessionKey) || this.clientSessions[sessionKey] === undefined) {
			throw new Error ("You need to login first, please check our guide at https://telepilot.co/login-howto")
		}
		const clientSession = this.clientSessions[sessionKey];

		try {
			// Properly close the client
			await clientSession.client.invoke({
				_: 'close'
			});
			clientSession.client.off();
			clientSession.client.close();
		} catch (e) {
			debug("Error during client close:", e);
		}

		delete this.clientSessions[sessionKey];

		// Update persistent sessions
		await this.saveSessions();

		debug(Object.keys(this.clientSessions));
		return true;
	}

	async deleteLocalInstance(apiId: number, phoneNumber: string): Promise<Record<string, string>> {
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		let clients_keys = Object.keys(this.clientSessions);
		if (!clients_keys.includes(sessionKey) || this.clientSessions[sessionKey] === undefined) {
			// If session doesn't exist, still attempt to remove files just in case
			debug(`Session ${sessionKey} not found for deletion, attempting file cleanup anyway.`);
		} else {
			const clientSession = this.clientSessions[sessionKey];
			try {
				// Close the specific client properly
				debug(`Closing client for session ${sessionKey}`);
				await clientSession.client.invoke({
					_: 'close'
				});
				clientSession.client.off();
				clientSession.client.close();
				debug(`Client closed for session ${sessionKey}`);
			} catch (e) {
				debug(`Error closing client for session ${sessionKey} (might be already closed):`, e);
			}
			// Remove session from map
			delete this.clientSessions[sessionKey];
			debug(`Removed session ${sessionKey} from map.`);
		}

		let result: Record<string, string> = {}
		const removeDir = async (dirPath: string) => {
			try {
				debug(`Attempting to remove directory: ${dirPath}`);
				await fs.rm(dirPath, {recursive: true, force: true});
				debug(`Successfully removed directory: ${dirPath}`);
			} catch (e: any) {
				if (e.code === 'ENOENT') {
					debug(`Directory not found, skipping removal: ${dirPath}`);
				} else {
					debug(`Error removing directory ${dirPath}:`, e);
				}
			}
		}

		const db_database_path = this.getTdDatabasePathForClient(apiId, phoneNumber);
		await removeDir(db_database_path);
		result["db_database"] = `Attempted removal of ${db_database_path}`;

		const db_files_path = this.getTdFilesPathForClient(apiId, phoneNumber);
		await removeDir(db_files_path);
		result["db_files"] = `Attempted removal of ${db_files_path}`;

		// Update persistent sessions
		await this.saveSessions();

		debug(`Local instance cleanup finished for ${sessionKey}. Global TDLib config preserved.`);

		return result;
	}

	getTdDatabasePathForClient(apiId: number, phoneNumber: string) {
		const sanitizedPhone = phoneNumber.replace(/[^0-9]/g, '');
		return `${this.TD_DATABASE_PATH_PREFIX}/${apiId}_${sanitizedPhone}/_td_database`;
	}

	getTdFilesPathForClient(apiId: number, phoneNumber: string) {
		const sanitizedPhone = phoneNumber.replace(/[^0-9]/g, '');
		return `${this.TD_FILES_PATH_PREFIX}/${apiId}_${sanitizedPhone}/_td_files`;
	}

	async clientLoginWithPhoneNumber(apiId: number, apiHash: string, phone_number: string): Promise<string> {
		debug("clientLoginWithPhoneNumber");
		const sessionKey = this.getSessionKey(apiId, phone_number);
		let clientSession = this.clientSessions[sessionKey];

		debug("clientLoginWithPhoneNumber.authState:" + clientSession.authState);
		if (clientSession.authState == TelepilotAuthState.WAIT_PHONE_NUMBER) {
			let result = await clientSession.client.invoke({
				_: 'setAuthenticationPhoneNumber',
				phone_number
			});
			return result;
		}
		return "";
	}

	async clientLoginSendAuthenticationCode(apiId: number, code: string, phoneNumber: string): Promise<string> {
		debug("clientLoginSendAuthenticationCode");
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		let clientSession = this.clientSessions[sessionKey];
		let result = await clientSession.client.invoke({
			_: 'checkAuthenticationCode',
			code
		});
		return result;
	}

	async clientLoginSendAuthenticationPassword(apiId: number, password: string, phoneNumber: string): Promise<string> {
		debug("clientLoginSendAuthenticationPassword");
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		let clientSession = this.clientSessions[sessionKey];
		let result = await clientSession.client.invoke({
			_: 'checkAuthenticationPassword',
			password
		});

		// Save sessions after successful login with password
		await this.saveSessions();

		return result;
	}

	async createClientSetAuthHandlerForPhoneNumberLogin(apiId: number, apiHash: string, phoneNumber: string): Promise<ClientSession> {
		let client: typeof Client;
		const sessionKey = this.getSessionKey(apiId, phoneNumber);

		// Ensure sessions are loaded
		await this.ensureSessionsLoaded();

		// Check if we already have this session
		if (this.clientSessions[sessionKey] === undefined) {
			// Try to restore session from saved data
			const sessionRestored = await this.restoreSession(apiId, apiHash, phoneNumber);

			// If session couldn't be restored, initialize a new one
			if (!sessionRestored) {
				debug(`Creating new client session for ${sessionKey}`);
				client = this.initClient(apiId, apiHash, phoneNumber);
				let clientSession = new ClientSession(client, TelepilotAuthState.NO_CONNECTION, phoneNumber);
				this.clientSessions[sessionKey] = clientSession;
			}
		}

		// Set up auth handler regardless of whether session is new or existing
		const authHandler = (update: IDataObject) => {
			if (update._ === "updateAuthorizationState") {
				debug('authHandler.Got updateAuthorizationState:', JSON.stringify(update, null, 2))
				const authorization_state = update.authorization_state as IDataObject;
				// Ensure session key is used here
				const currentSessionKey = this.getSessionKey(apiId, phoneNumber);
				if (this.clientSessions[currentSessionKey] !== undefined) {
					this.clientSessions[currentSessionKey].authState = getEnumFromString(TelepilotAuthState, authorization_state._ as string);
					debug(`set clientSession ${currentSessionKey} authState to ` + this.clientSessions[currentSessionKey].authState);

					// If we reach WAIT_READY state, save sessions
					if (this.clientSessions[currentSessionKey].authState === TelepilotAuthState.WAIT_READY) {
						this.saveSessions();
					}
				}
			}
		}

		// Ensure session key is used here
		this.clientSessions[sessionKey].client
			.on('update', authHandler)

		await sleep(1000);
		return this.clientSessions[sessionKey];
	}

	private initClient(apiId: number, apiHash: string, phoneNumber: string) {
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		let clients_keys = Object.keys(this.clientSessions);

		// Use the original locateBinaryModules method
		let {libFolder, libFile} = this.locateBinaryModules();
		debug("nodeVersion:", nodeVersion);
		debug("binaryVersion:", binaryVersion);
		debug("addonVersion:", addonVersion);

		if (!clients_keys.includes(sessionKey) || this.clientSessions[sessionKey] === undefined) {
			// Configure before creating the first client for this process
			if (!this.tdlConfigured) {
				debug(`Configuring TDLib with libdir: ${libFolder}, file: ${libFile}`);
				// Log tdl object properties for debugging
				debug('TDL object keys:', Object.keys(tdl));
				try {
					// Use the direct backup reference to avoid potential issues
					tdlConfigure({
						libdir: libFolder,
						tdjson: libFile
					});
					this.tdlConfigured = true;
					debug('TDLib configuration successful');
				} catch (e: any) {
					debug('Error during TDLib configuration attempt:', e.message);
					if (e.message && e.message.includes('already initialized')) {
						debug('TDLib was already configured elsewhere, marking as configured');
						this.tdlConfigured = true; // Mark as configured even if error occurred
					} else {
						throw e; // Rethrow other configuration errors
					}
				}
			}

			try {
				debug(`Creating client for session: ${sessionKey}`);
				return tdl.createClient({
					apiId,
					apiHash,
					databaseDirectory: this.getTdDatabasePathForClient(apiId, phoneNumber),
					filesDirectory: this.getTdFilesPathForClient(apiId, phoneNumber),
					nodeVersion,
					binaryVersion,
					addonVersion
				});
			} catch (e: any) {
				debug(`Error creating TDLib client for session ${sessionKey}:`, e.message);
				throw e;
			}
		} else {
			debug(`Reusing existing client for session ${sessionKey}`);
			return this.clientSessions[sessionKey].client;
		}
	}

	// Reintroduce the original locateBinaryModules method
	private locateBinaryModules() {
		// Get the path to the prebuilt library directly from the installed package
		const prebuiltPackageName = "@telepilotco/tdlib-binaries-prebuilt";
		const prebuildsDir = "prebuilds";
		let libFile = "";
		let libFolder = "";

		try {
			// First, try to resolve the path to the prebuilt package
			// This is more reliable than using relative paths
			const resolvePackagePath = require.resolve(`${prebuiltPackageName}/package.json`);
			const packageDir = resolvePackagePath.substring(0, resolvePackagePath.lastIndexOf('/'));
			libFolder = `${packageDir}/${prebuildsDir}`;
			debug(`Resolved prebuilt path: ${libFolder}`);
		} catch (err) {
			// Fallback to the relative path approach if resolution fails
			debug(`Failed to resolve prebuilt package path: ${err.message}`);
			debug(`Falling back to relative path for ${prebuiltPackageName}`);
			const _lib_prebuilt_package = `${prebuiltPackageName}/prebuilds/`;
			libFolder = __dirname + "/../../../../node_modules/" + _lib_prebuilt_package;
			debug(`Fallback path: ${libFolder}`);
		}

		// Determine the appropriate binary file based on architecture and platform
		if (process.arch === "x64") {
			switch (process.platform) {
				case "win32":
					throw new Error("Your n8n installation is currently not supported, please refer to https://telepilot.co/nodes/telepilot/#win-x64");
				case 'darwin':
					throw new Error("Your n8n installation is currently not supported, please refer to https://telepilot.co/nodes/telepilot/#macos-x64");
				case 'linux':
					libFile = "libtdjson.so";
					break;
				default:
					throw new Error("Not implemented for " + process.platform);
			}
		} else if (process.arch == "arm64") {
			switch (process.platform) {
				case "darwin":
					libFile = "libtdjson.dylib";
					break;
				case "linux":
					libFile = "libtdjson.so";
					break;
				default:
					throw new Error("Your n8n installation is currently not supported, please refer to https://telepilot.co/nodes/telepilot/#win-arm64");
			}
		}

		debug(`Binary resolution: libFolder=${libFolder}, libFile=${libFile}`);
		return {libFolder, libFile};
	}

	markClientAsClosed(apiId: number, phoneNumber: string) {
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		if (this.clientSessions[sessionKey] !== undefined) {
			delete this.clientSessions[sessionKey];
			// Update persistent sessions
			this.saveSessions();
		}
	}

	async getAuthStateForCredential(apiId: number, phoneNumber: string) {
		// Ensure sessions are loaded
		await this.ensureSessionsLoaded();

		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		if (this.clientSessions[sessionKey] === undefined) {
			// If no session exists, return NO_CONNECTION
			// We no longer track global isInitialized state directly here
			return TelepilotAuthState.NO_CONNECTION;
		} else {
			const clientSession = this.clientSessions[sessionKey];
			return clientSession.authState;
		}
	}

	getAllClientSessions() {
		return Object.entries(this.clientSessions).map(([key, value]) => {
			return {
				apiId: key.split(':')[0],
				phoneNumber: key.split(':')[1],
				authState: value.authState
			};
		});
	}
}
