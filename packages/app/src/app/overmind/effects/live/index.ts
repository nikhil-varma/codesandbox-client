import {
  Directory,
  IModuleStateModule,
  LiveMessageEvent,
  Module,
  RoomInfo,
  UserSelection,
  UserViewRange,
} from '@codesandbox/common/es/types';
import {
  captureException,
  logBreadcrumb,
} from '@codesandbox/common/es/utils/analytics/sentry';
import _debug from '@codesandbox/common/es/utils/debug';
import VERSION from '@codesandbox/common/es/version';
import { blocker } from 'app/utils/blocker';
import { camelizeKeys } from 'humps';
import { SerializedTextOperation, TextOperation } from 'ot';
import { Channel, Presence, Socket } from 'phoenix';
import uuid from 'uuid';

import { OPTIMISTIC_ID_PREFIX } from '../utils';
import { CodesandboxOTClientsManager } from './clients';

type Options = {
  onApplyOperation(args: {
    moduleShortid: string;
    operation: TextOperation;
  }): void;
  provideJwtToken(): string;
  onOperationError(payload: {
    moduleShortid: string;
    moduleInfo: IModuleStateModule;
  }): void;
};

type JoinChannelResponse = {
  liveUserId: string;
  reconnectToken: string;
  roomInfo: RoomInfo;
  moduleState: {
    [moduleId: string]: IModuleStateModule;
  };
};

type JoinChannelErrorResponse = {
  reason: 'room not found' | string;
};

declare global {
  interface Window {
    socket: any;
  }
}

class Live {
  private identifier = uuid.v4();
  private pendingMessages = new Map();
  private debug = _debug('cs:socket');
  private channel: Channel | null;
  private messageIndex = 0;
  private clientsManager: CodesandboxOTClientsManager;
  private socket: Socket;
  private presence: Presence;
  private provideJwtToken: () => string;
  private onApplyOperation: (moduleShortid: string, operation: any) => void;
  private onOperationError: (payload: {
    moduleShortid: string;
    moduleInfo: IModuleStateModule;
  }) => void;

  private liveInitialized = blocker();

  private operationToElixir(ot: (number | string)[]) {
    return ot.map((op: number | string) => {
      if (typeof op === 'number') {
        if (op < 0) {
          return { d: -op };
        }

        return op;
      }

      return { i: op };
    });
  }

  private connectionsCount = 0;

  private onSendOperation = async (
    moduleShortid: string,
    revision: number,
    operation: TextOperation
  ) => {
    logBreadcrumb({
      category: 'ot',
      message: `Sending ${JSON.stringify({
        moduleShortid,
        revision,
        operation,
      })}`,
    });

    return this.send('operation', {
      moduleShortid,
      operation: this.operationToElixir(operation.toJSON()),
      revision,
    }).catch(error => {
      logBreadcrumb({
        category: 'ot',
        message: `ERROR ${JSON.stringify({
          moduleShortid,
          revision,
          operation,
          message: error.message,
        })}`,
      });

      captureException(error);
      if (error.module_state) {
        this.onOperationError({
          moduleInfo: error.module_state[moduleShortid],
          moduleShortid,
        });
      }
      throw new Error(
        'The code was out of sync with the server, we had to reset the file'
      );
    });
  };

  initialize(options: Options) {
    this.provideJwtToken = options.provideJwtToken;
    this.onOperationError = options.onOperationError;
    this.onApplyOperation = (moduleShortid, operation) =>
      options.onApplyOperation({
        moduleShortid,
        operation,
      });
    this.clientsManager = new CodesandboxOTClientsManager(
      this.onSendOperation,
      this.onApplyOperation
    );
  }

  getSocket() {
    return this.socket || this.connect();
  }

  connect(): Socket {
    if (!this.socket) {
      const protocol = process.env.LOCAL_SERVER ? 'ws' : 'wss';
      this.socket = new Socket(`${protocol}://${location.host}/socket`, {
        params: {
          guardian_token: this.provideJwtToken(),
          client_version: VERSION,
        },
      });

      this.socket.connect();
      window.socket = this.socket;
      this.debug('Connecting to socket', this.socket);
    }

    return this.socket;
  }

  disconnect() {
    return new Promise((resolve, reject) => {
      if (!this.channel) {
        resolve({});
        return;
      }

      this.channel
        .leave()
        .receive('ok', resp => {
          if (!this.channel) {
            return resolve({});
          }

          this.channel.onMessage = d => d;
          this.channel = null;
          this.pendingMessages.clear();
          this.messageIndex = 0;

          return resolve(resp);
        })
        // eslint-disable-next-line prefer-promise-reject-errors
        .receive('error', resp => reject(resp));
    });
  }

  joinChannel(
    roomId: string,
    onError: (reason: string) => void
  ): Promise<JoinChannelResponse> {
    return new Promise((resolve, reject) => {
      this.channel = this.getSocket().channel(`live:${roomId}`, { version: 2 });
      this.channel
        .join()
        .receive('ok', resp => {
          const result = camelizeKeys(resp) as JoinChannelResponse;
          result.moduleState = resp.module_state; // Don't camelize this!!

          // We rewrite what our reconnect params are by adding the reconnect token.
          // This token makes sure that you can retain state between reconnects and restarts
          // from the server
          // @ts-ignore
          this.channel.joinPush.payload = () => ({
            version: 2,
            reconnect_token: result.reconnectToken,
          });

          this.presence = new Presence(this.channel!);
          this.presence.onSync(() => {
            this.connectionsCount = this.presence.list().length;
          });

          resolve(result);
        })
        .receive('error', (resp: JoinChannelErrorResponse) => {
          if (resp.reason === 'room not found') {
            if (this.channel) {
              this.channel.leave();
            }
            onError(resp.reason);
          }
          reject(camelizeKeys(resp));
        });
    });
  }

  // TODO: Need to take an action here
  listen(
    action: (payload: {
      event: LiveMessageEvent;
      _isOwnMessage: boolean;
      data: object;
    }) => {}
  ) {
    if (!this.channel) {
      return;
    }

    this.channel.onMessage = (event: any, data: any) => {
      const disconnected =
        (data == null || Object.keys(data).length === 0) &&
        event === 'phx_error';
      const alteredEvent = disconnected ? 'connection-loss' : event;

      const _isOwnMessage = Boolean(
        data && data._messageId && this.pendingMessages.delete(data._messageId)
      );

      if (event && (event === 'phx_reply' || event.startsWith('chan_reply_'))) {
        // No action listens to this
        return data;
      }

      action({
        event: alteredEvent,
        _isOwnMessage,
        data: data == null ? {} : data,
      });

      return data;
    };
  }

  private send<T>(event, payload: any = {}): Promise<T> {
    const _messageId = this.identifier + this.messageIndex++;
    // eslint-disable-next-line
    payload._messageId = _messageId;
    this.pendingMessages.set(_messageId, payload);

    return new Promise((resolve, reject) => {
      if (this.channel) {
        this.channel
          .push(event, payload)
          .receive('ok', resolve)
          .receive('error', reject);
      } else {
        // we might try to send messages even when not on live, just
        // ignore it
        resolve();
      }
    });
  }

  awaitModuleSynced(moduleShortid: string) {
    return Promise.resolve(
      this.clientsManager.get(moduleShortid).awaitSynchronized?.promise
    );
  }

  sendModuleUpdate(module: Module) {
    return this.send('module:updated', {
      type: 'module',
      moduleShortid: module.shortid,
      module,
    });
  }

  sendDirectoryUpdate(directory: Directory) {
    return this.send('directory:updated', {
      type: 'directory',
      directoryShortid: directory.shortid,
      module: directory,
    });
  }

  sendCodeUpdate(moduleShortid: string, operation: TextOperation) {
    if (!operation) {
      return;
    }

    if (operation.ops.length === 1) {
      const [op] = operation.ops;
      if (typeof op === 'number' && op >= 0) {
        // Useless to send a single retain operation, ignore
        return;
      }
    }

    if (moduleShortid.startsWith(OPTIMISTIC_ID_PREFIX)) {
      // Module is an optimistic module, we will send a full code update
      // once the module has been created, until then, send nothing!
      return;
    }

    try {
      this.clientsManager.get(moduleShortid).applyClient(operation);
    } catch (e) {
      e.name = 'OperationFailure';
      captureException(e);
      // Something went wrong, probably a sync mismatch. Request new version
      this.send('live:module_state', {});
    }
  }

  sendExternalResourcesChanged(externalResources: string[]) {
    return this.send('sandbox:external-resources', {
      externalResources,
    });
  }

  sendUserCurrentModule(moduleShortid: string) {
    return this.send('user:current-module', {
      moduleShortid,
    });
  }

  sendDirectoryCreated(directory: Directory) {
    return this.send('directory:created', {
      type: 'directory',
      module: directory,
    });
  }

  sendDirectoryDeleted(directoryShortid: string) {
    this.send('directory:deleted', {
      type: 'directory',
      directoryShortid,
    });
  }

  sendModuleCreated(module: Module) {
    return this.send('module:created', {
      type: 'module',
      moduleShortid: module.shortid,
      module,
    });
  }

  sendModuleDeleted(moduleShortid: string) {
    return this.send('module:deleted', {
      type: 'module',
      moduleShortid,
    });
  }

  sendMassCreatedModules(modules: Module[], directories: Directory[]) {
    return this.send('module:mass-created', {
      directories,
      modules,
    });
  }

  sendLiveMode(mode: string) {
    return this.send('live:mode', {
      mode,
    });
  }

  sendEditorAdded(liveUserId: string) {
    return this.send('live:add-editor', {
      editor_user_id: liveUserId,
    });
  }

  sendEditorRemoved(liveUserId: string) {
    return this.send('live:remove-editor', {
      editor_user_id: liveUserId,
    });
  }

  sendModuleSaved(module: Module) {
    return this.send('module:saved', {
      type: 'module',
      module,
      moduleShortid: module.shortid,
    });
  }

  sendClosed() {
    return this.send('live:close', {});
  }

  sendChat(message: string) {
    return this.send('chat', {
      message,
    });
  }

  sendChatEnabled(enabled: boolean) {
    return this.send('live:chat_enabled', { enabled });
  }

  sendModuleStateSyncRequest() {
    return this.send('live:module_state', {});
  }

  sendUserViewRange(
    moduleShortid: string | null,
    liveUserId: string,
    viewRange: UserViewRange
  ) {
    if (this.connectionsCount === 1) {
      return Promise.resolve();
    }

    return this.send('user:view-range', {
      liveUserId,
      moduleShortid,
      viewRange,
    });
  }

  sendUserSelection(
    moduleShortid: string | null,
    liveUserId: string,
    selection: UserSelection
  ) {
    if (this.connectionsCount === 1) {
      return Promise.resolve();
    }

    return this.send('user:selection', {
      liveUserId,
      moduleShortid,
      selection,
    });
  }

  async saveModule(module: Module) {
    const client = this.clientsManager.get(module.shortid);
    await client.awaitSynchronized?.promise;

    return this.send<{
      saved_code: string;
      updated_at: string;
      inserted_at: string;
      version: number;
    }>('save', {
      path: module.path,
      revision: client.revision - 1,
    });
  }

  waitForLiveReady() {
    return this.liveInitialized.promise;
  }

  markLiveReady() {
    this.liveInitialized.resolve(undefined);
  }

  reset() {
    this.clientsManager.clear();
    this.liveInitialized.reject(undefined);
    this.liveInitialized = blocker();
  }

  resetClient(moduleShortid: string, revision: number) {
    this.clientsManager.reset(moduleShortid, revision);
  }

  hasClient(moduleShortid: string) {
    return this.clientsManager.has(moduleShortid);
  }

  getClient(moduleShortid: string) {
    return this.clientsManager.get(moduleShortid);
  }

  getAllClients() {
    return this.clientsManager.getAll();
  }

  applyClient(moduleShortid: string, operation: SerializedTextOperation) {
    return this.clientsManager
      .get(moduleShortid)
      .applyClient(TextOperation.fromJSON(operation));
  }

  applyServer(moduleShortid: string, operation: SerializedTextOperation) {
    return this.clientsManager
      .get(moduleShortid)
      .applyServer(TextOperation.fromJSON(operation));
  }

  serverAck(moduleShortid: string) {
    return this.clientsManager.get(moduleShortid).serverAck();
  }

  createClient(moduleShortid: string, revision: number) {
    return this.clientsManager.create(moduleShortid, revision);
  }
}

export default new Live();
