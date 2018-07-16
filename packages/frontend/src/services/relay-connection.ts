import Service from '@ember/service';
import { service } from '@ember-decorators/service';
import { Channel, Socket } from 'phoenix';

import IdentityService from 'emberclear/services/identity/service';
import MessageProcessor from 'emberclear/services/messages/processor';
import MessageDispatcher from 'emberclear/services/messages/dispatcher';
import RelayManager from 'emberclear/services/relay-manager';

import { toHex } from 'emberclear/src/utils/string-encoding';

// Official phoenix js docs: https://hexdocs.pm/phoenix/js/
export default class RelayConnection extends Service {
  @service('messages/processor') processor!: MessageProcessor;
  @service('messages/dispatcher') dispatcher!: MessageDispatcher;
  @service('notifications') toast!: Toast;
  @service('intl') intl!: Intl;
  @service relayManager!: RelayManager;
  @service identity!: IdentityService;

  socket?: Socket;
  channel?: Channel;

  connected = false;

  // TODO: add support for sending along a specific channel / chat-room
  // TODO: consider chatroom implementation with server, or keeping it all
  //       filtered on the frontend, as it has been in previous implementations
  //
  //       Pros of Client-Side Channels
  //       - server implementation is simple
  //       - server-side channels could potentially have lots more channels on the server
  //         - this could burn through resources quicker, especially on free tier IaaS
  //
  //       Cons of Client Side Channels
  //       - more complicated logic for a problem that already been solved
  //
  send(this: RelayConnection, to: string, data: string) {
    const payload = { to, message: data };
    const channel = this.get('channel');

    if (!channel) {
      return console.error(this.intl.t('connection.errors.send.notConnected'));
    }

    return new Promise((resolve, reject) => {
      channel
        .push('chat', payload)
        .receive("ok", resolve)
        .receive("error", reject)
        .receive("timeout",
          () => reject({ reason: this.intl.t('models.message.errors.timeout') }));
    });
  }

  // TODO: ensure not already connected
  async canConnect(this: RelayConnection): Promise<boolean> {
    return await this.identity.exists();
  }

  userChannelId(): string {
    const publicKey = this.identity.publicKey;

    if (!publicKey) return '';

    return toHex(publicKey);
  }

  // each user has at least one channel that they subscribe to
  // this is for direct messages
  // subsequent rooms may be subscribed to, and are denoted by
  // :roomname at the end of the channel.
  //
  // user channel: user:<publicKey>
  // room channel: room:<roomName>,user:<publicKey,
  //
  // this format is because every sent message must be
  // individually encrypted and sent to specific channels
  //
  // TODO: investigate capabilities of the phoenix websocket server
  //       if a message can be broadcast to a specific user on
  //       a channel, then we don't need a room-channel per user.
  //       this would greatly reduce the number of channels needed
  //       for chat rooms
  async connect(this: RelayConnection) {
    const canConnect = await this.canConnect();
    if (!canConnect || this.connected) return;

    this.toast.info(this.intl.t('connection.connecting'));

    const publicKey = this.userChannelId();
    const url = this.relayManager.getRelay().socket;

    const socket = new Socket(url, { params: { uid: publicKey } });
    this.set('socket', socket);

    socket.onError(this.onSocketError);
    socket.onClose(this.onSocketClose);

    // establish initial connection to the server
    socket.connect();
    this.subscribeToChannel(`user:${publicKey}`);

    this.set('connected', true);

    // ping for user statuses
    this.dispatcher.pingAll();
  }

  subscribeToChannel(this: RelayConnection, channelName: string) {
    const { socket, toast } = this;

    if (!socket) {
      return toast.error(this.intl.t('connection.errors.subscribe.notConnected'));
    }

    // subscribe and hook up things.
    const channel = socket.channel(channelName, {});
    this.set('channel', channel);

    channel.onError(this.onChannelError);
    channel.onClose(this.onChannelClose);
    channel.on('chat', this.handleMessage);

    channel
      .join()
      .receive('ok', this.handleConnected)
      .receive('error', this.handleError)
      .receive("timeout", () => console.info(this.intl.t('connection.status.timeout')) );

  }

  onSocketError = () => {
    this.toast.error(this.intl.t('connection.status.socket.error'));
  }

  onSocketClose = () => {
    this.toast.info(this.intl.t('connection.status.socket.close'));
    this.set('connected', false);
  }


  onChannelError = () => {
    console.log('channel errored');
    if (this.socket) this.socket.disconnect();
  }

  onChannelClose = () => {
    console.log('channel closed');
    if (this.socket) this.socket.disconnect();
  }

  handleError = (data: string) => {
    console.error(data);
  }

  handleConnected = () => {
    this.toast.success(this.intl.t('connection.connected'));
  }

  handleMessage = (data: RelayMessage) => {
    this.processor.receive(data);
  }
}

// DO NOT DELETE: this is how TypeScript knows how to look up your services.
declare module '@ember/service' {
  interface Registry {
    'relay-connection': RelayConnection
  }
}
