import 'reflect-metadata';
import { Service } from 'typedi';
import {IDataObject} from "n8n-workflow";
const { Client } = require('@telepilotco/tdl');
const tdl = require('@telepilotco/tdl');
// const childProcess = require('child_process');

const debug = require('debug')('telepilot-cm')

const fs = require('fs/promises');

var pjson = require('../../package.json');
const nodeVersion = pjson.version;

const binaryVersion = pjson.dependencies["@telepilotco/tdlib-binaries-prebuilt"].replace("^", "");
const addonVersion = pjson.dependencies["@telepilotco/tdl"].replace("^", "");

// Global TDLib initialization flag
let tdlInitialized = false;

// Try to initialize TDLib globally once at module load time
function initializeTDLib() {
	if (!tdlInitialized) {
		try {
			const libFolder = __dirname + "/../../../../tdlib-binaries-prebuilt/prebuilds/";
			const libFile = process.platform === 'darwin' ? "libtdjson.dylib" : "libtdjson.so";

			debug("Trying to initialize TDLib globally");
			tdl.configure({
				libdir: libFolder,
				tdjson: libFile
			});
			tdlInitialized = true;
			debug("TDLib initialized successfully");
		} catch (e) {
			if (e.message && e.message.includes("already initialized")) {
				debug("TDLib was already initialized globally");
				tdlInitialized = true;
			} else {
				debug("Error initializing TDLib:", e.message);
				// Don't throw error here, we'll try again when creating client
			}
		}
	}
}

// Try to initialize once at load time
initializeTDLib();

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

	private clientSessions: Record<string, ClientSession> = {};
	private TD_DATABASE_PATH_PREFIX = process.env.HOME + "/.n8n/nodes/node_modules/@telepilotco/n8n-nodes-telepilot/db"
	private TD_FILES_PATH_PREFIX = process.env.HOME + "/.n8n/nodes/node_modules/@telepilotco/n8n-nodes-telepilot/db"


	constructor() {

	}

	// Helper method to generate a unique session key from apiId and phoneNumber
	private getSessionKey(apiId: number, phoneNumber: string): string {
		return `${apiId}:${phoneNumber}`;
	}

	async closeLocalSession(apiId: number, phoneNumber: string) {
		debug("closeLocalSession apiId:" + apiId + ", phoneNumber:" + phoneNumber);
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		let clients_keys = Object.keys(this.clientSessions);
		if (!clients_keys.includes(sessionKey) || this.clientSessions[sessionKey] === undefined) {
			throw new Error ("You need to login first, please check our guide at https://telepilot.co/login-howto")
		}
		const clientSession = this.clientSessions[sessionKey];
		// let result = await clientSession.client.invoke({
		// 	_: 'close'
		// })
		clientSession.client.off
		let result = clientSession.client.close();
		delete this.clientSessions[sessionKey];
		debug(Object.keys(this.clientSessions))
		return result;
	}
	async deleteLocalInstance(apiId: number, phoneNumber: string): Promise<Record<string, string>> {
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		let clients_keys = Object.keys(this.clientSessions);
		if (!clients_keys.includes(sessionKey) || this.clientSessions[sessionKey] === undefined) {
			throw new Error ("You need to login first, please check our guide at https://telepilot.co/login-howto")
		}
		const clientSession = this.clientSessions[sessionKey];

		try {
			await clientSession.client.invoke({
				_: 'close'
			})
		} catch (e) {
			debug("Connection was already closed")
		}

		let result: Record<string, string> = {}
		const removeDir = async (dirPath: string) => {
			await fs.rm(dirPath, {recursive: true});
		}

		const db_database_path = this.getTdDatabasePathForClient(apiId, phoneNumber);
		await removeDir(db_database_path)
		result["db_database"] = `Removed ${db_database_path}`

		const db_files_path = this.getTdFilesPathForClient(apiId, phoneNumber);
		await removeDir(db_files_path)
		result["db_files"] = `Removed ${db_files_path}`

		delete this.clientSessions[sessionKey];
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

		// result = await clientSession.client.invoke({
		// 	_: 'checkAuthenticationCode',
		// 	code: ""
		// });
		//
		// result = await clientSession.client.invoke({
		// 	_: 'checkAuthenticationPassword',
		// 	password: ""
		// });


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
		return result;
	}

	async createClientSetAuthHandlerForPhoneNumberLogin(apiId: number, apiHash: string, phoneNumber: string): Promise<ClientSession> {
		let client: typeof Client;
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		if (this.clientSessions[sessionKey] === undefined) {
			client = this.initClient(apiId, apiHash, phoneNumber);
			let clientSession = new ClientSession(client, TelepilotAuthState.NO_CONNECTION, phoneNumber);
			this.clientSessions[sessionKey] = clientSession;
		}
		const authHandler = (update: IDataObject) => {
			if (update._ === "updateAuthorizationState") {
				debug('authHandler.Got updateAuthorizationState:', JSON.stringify(update, null, 2))
				const authorization_state = update.authorization_state as IDataObject;
				if (this.clientSessions[sessionKey] !== undefined) {
					this.clientSessions[sessionKey].authState = getEnumFromString(TelepilotAuthState, authorization_state._ as string);
					debug("set clientSession.authState to " + this.clientSessions[sessionKey].authState)
				}
			}
		}

		this.clientSessions[sessionKey].client
			.on('update', authHandler)

		await sleep(1000);
		return this.clientSessions[sessionKey];
	}

	private initClient(apiId: number, apiHash: string, phoneNumber: string) {
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		let clients_keys = Object.keys(this.clientSessions);
		let {libFolder, libFile} = this.locateBinaryModules();
		debug("nodeVersion:", nodeVersion);
		debug("binaryVersion:", binaryVersion);
		debug("addonVersion:", addonVersion);
		if (!clients_keys.includes(sessionKey) || this.clientSessions[sessionKey] === undefined) {
			// Try to initialize TDLib if not already initialized
			if (!tdlInitialized) {
				try {
					debug("Trying to initialize TDLib from initClient");
					tdl.configure({
						libdir: libFolder,
						tdjson: libFile
					});
					tdlInitialized = true;
					debug("TDLib initialized successfully from initClient");
				} catch (e) {
					if (e.message && e.message.includes("already initialized")) {
						debug("TDLib was already initialized (from initClient)");
						tdlInitialized = true;
					} else {
						debug("Error initializing TDLib from initClient:", e.message);
						// Don't throw - just continue and try to create the client
					}
				}
			}

			try {
				return tdl.createClient({
					apiId,
					apiHash,
					databaseDirectory: this.getTdDatabasePathForClient(apiId, phoneNumber),
					filesDirectory: this.getTdFilesPathForClient(apiId, phoneNumber),
					nodeVersion,
					binaryVersion,
					addonVersion
					// useTestDc: true
				});
			} catch (e) {
				debug("Error creating TDLib client:", e.message);
				throw e;
			}
		} else {
			return this.clientSessions[sessionKey].client;
		}
	}

// @ts-ignore
	private locateBinaryModules() {
		let _lib_prebuilt_package = "tdlib-binaries-prebuilt/prebuilds/";

		let libFile = "";
		const libFolder = __dirname + "/../../../../" + _lib_prebuilt_package;

		if (process.arch === "x64") {
			switch (process.platform) {
				case "win32":
					throw new Error("Your n8n installation is currently not supported, " +
						"please refer to https://telepilot.co/nodes/telepilot/#win-x64")
					break;
				case 'darwin':
					throw new Error("Your n8n installation is currently not supported, " +
						"please refer to https://telepilot.co/nodes/telepilot/#macos-x64")
					break;
				case 'linux':
						// libFile = libFolder + "libtdjson" + ".so"
						libFile = "libtdjson" + ".so"
					break;
				default:
					throw new Error("Not implemented for " + process.platform);
			}
		} else if (process.arch == "arm64") {
			switch (process.platform) {
				case "darwin":
					// 	"please refer to https://telepilot.co/nodes/telepilot/#macos-arm64")
					libFile = "libtdjson" + ".dylib"
					break;
				case "linux":
					libFile = "libtdjson" + ".so"
					break;
				default:
					throw new Error("Your n8n installation is currently not supported, " +
						"please refer to https://telepilot.co/nodes/telepilot/#win-arm64")
			}
		}
		// return {libFile, bridgeFile};
		return {libFolder, libFile};
	}

	markClientAsClosed(apiId: number, phoneNumber: string) {
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		if (this.clientSessions[sessionKey] !== undefined) {
			delete this.clientSessions[sessionKey];
		}
	}

	getAuthStateForCredential(apiId: number, phoneNumber: string) {
		const sessionKey = this.getSessionKey(apiId, phoneNumber);
		if (this.clientSessions[sessionKey] === undefined) {
			return TelepilotAuthState.NO_CONNECTION;
		} else {
			const clientSession = this.clientSessions[sessionKey];
			return clientSession.authState;
		}
	}

	getAllClientSessions() {
		return Object.entries(this.clientSessions).map(([key, value]) => {
			// Perform some transformation on each ClientSession instance
			return {
				apiId: key.split(':')[0],
				phoneNumber: key.split(':')[1],
				authState: value.authState
			};
		});
	}
}
