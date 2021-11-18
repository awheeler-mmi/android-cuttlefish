/*
 * Copyright (C) 2021 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

// The public elements in this file implement the Server Connector Interface,
// part of the contract between the signaling server and the webrtc client.
// No changes that break backward compatibility are allowed here. Any new
// features must be added as a new function/class in the interface. Any
// additions to the interface must be checked for existence by the client before
// using it.

// The id of the device the client is supposed to connect to.
// The List Devices page in the signaling server may choose any way to pass the
// device id to the client page, this function retrieves that information once
// the client loaded.
// In this case the device id is passed as a parameter in the url.
export function deviceId() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('deviceId');
}

// Creates a connector capable of communicating with the signaling server.
export async function createConnector() {
  try {
    let ws = await connectWs();
    console.debug(`Connected to ${ws.url}`);
    return new WebsocketConnector(ws);
  } catch (e) {
    console.error('WebSocket error:', e);
  }
  console.warn('Failed to connect websocket, trying polling instead');

  return new PollingConnector();
}

// A connector object provides high level functions for communicating with the
// signaling server, while hiding away implementation details.
// This class is an interface and shouldn't be instantiated direclty.
// Only the public methods present in this class form part of the Server
// Connector Interface, any implementations of the interface are considered
// internal and not accessible to client code.
class Connector {
  constructor() {
    if (this.constructor == Connector) {
      throw new Error('Connector is an abstract class');
    }
  }

  // Selects a particular device in the signaling server and opens the signaling
  // channel with it (but doesn't send any message to the device). Returns a
  // promise to an object with the following properties:
  // - deviceInfo: The info object provided by the device when it registered
  // with the server.
  // - infraConfig: The server's infrastructure configuration (mainly STUN and
  // TURN servers)
  // The promise may take a long time to resolve if, for example, the server
  // decides to wait for a device with the provided id to register with it. The
  // promise may be rejected if there are connectivity issues, a device with
  // that id doesn't exist or this client doesn't have rights to access that
  // device.
  async requestDevice(deviceId) {
    throw 'Not implemented!';
  }

  // Sends a message to the device selected with requestDevice. It's an error to
  // call this function before the promise from requestDevice() has resolved.
  // Returns an empty promise that is rejected when the message can not be
  // delivered, either because the device has not been requested yet or because
  // of connectivity issues.
  async sendToDevice(msg) {
    throw 'Not implemented!';
  }
}

// End of Server Connector Interface.

// The following code is internal and shouldn't be accessed outside this file.

function httpUrl(path) {
  return location.protocol + '//' + location.host + '/' + path;
}

function websocketUrl(path) {
  return ((location.protocol == 'http:') ? 'ws://' : 'wss://') + location.host +
      '/' + path;
}

async function connectWs() {
  return new Promise((resolve, reject) => {
    let url = websocketUrl('connect_client');
    let ws = new WebSocket(url);
    ws.onopen = () => {
      resolve(ws);
    };
    ws.onerror = evt => {
      reject(evt);
    };
  });
}

async function ajaxPostJson(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-cache',
    headers: {'Content-Type': 'application/json'},
    redirect: 'follow',
    body: JSON.stringify(data),
  });
  return response.json();
}

// Implementation of the connector interface using websockets
class WebsocketConnector extends Connector {
  #websocket;
  #futures = {};
  #onDeviceMsgCb = msg =>
      console.error('Received device message without registered listener');

  onDeviceMsg(cb) {
    this.#onDeviceMsgCb = cb;
  }

  constructor(ws) {
    super();
    ws.onmessage = e => {
      let data = JSON.parse(e.data);
      this.#onWebsocketMessage(data);
    };
    this.#websocket = ws;
  }

  async requestDevice(deviceId) {
    return new Promise((resolve, reject) => {
      this.#futures.onDeviceAvailable = (device) => resolve(device);
      this.#futures.onConnectionFailed = (error) => reject(error);
      this.#wsSendJson({
        message_type: 'connect',
        device_id: deviceId,
      });
    });
  }

  async sendToDevice(msg) {
    return this.#wsSendJson({message_type: 'forward', payload: msg});
  }

  #onWebsocketMessage(message) {
    const type = message.message_type;
    if (message.error) {
      console.error(message.error);
      this.#futures.onConnectionFailed(message.error);
      return;
    }
    switch (type) {
      case 'config':
        this.#futures.infraConfig = message;
        break;
      case 'device_info':
        if (this.#futures.onDeviceAvailable) {
          this.#futures.onDeviceAvailable({
            deviceInfo: message.device_info,
            infraConfig: this.#futures.infraConfig,
          });
          delete this.#futures.onDeviceAvailable;
        } else {
          console.error('Received unsolicited device info');
        }
        break;
      case 'device_msg':
        this.#onDeviceMsgCb(message.payload);
        break;
      default:
        console.error('Unrecognized message type from server: ', type);
        this.#futures.onConnectionFailed(
            'Unrecognized message type from server: ' + type);
        console.error(message);
    }
  }

  async #wsSendJson(obj) {
    return this.#websocket.send(JSON.stringify(obj));
  }
}

// Implementation of the Connector interface using HTTP long polling
class PollingConnector extends Connector {
  #configUrl = httpUrl('infra_config');
  #connectUrl = httpUrl('polled_connections');
  #forwardUrl;
  #messagesUrl;
  #config = undefined;
  #messagesReceived = 0;
  #pollerSchedule;
  #onDeviceMsgCb = msg =>
      console.error('Received device message without registered listener');

  onDeviceMsg(cb) {
    this.#onDeviceMsgCb = cb;
  }

  constructor() {
    super();
  }

  async requestDevice(deviceId) {
    let config = await this.#getConfig();
    let response = await ajaxPostJson(this.#connectUrl, {device_id: deviceId});
    let connId = response.connection_id;
    this.#forwardUrl = httpUrl(`polled_connections/${connId}/:forward`);
    this.#messagesUrl = httpUrl(`polled_connections/${connId}/messages`);

    this.#startPolling();

    return {
      deviceInfo: response.device_info,
      infraConfig: config,
    };
  }

  async sendToDevice(msg) {
    return await ajaxPostJson(this.#forwardUrl, {
      payload: msg,
    });
  }

  async #getConfig() {
    if (this.#config === undefined) {
      this.#config = await (await fetch(this.#configUrl, {
                       method: 'GET',
                       redirect: 'follow',
                     })).json();
    }
    return this.#config;
  }

  async #pollMessages() {
    let r = await fetch(
        this.#messagesUrl + `?start=${this.#messagesReceived}`, {
          method: 'GET',
          redirect: 'follow',
        })
    let arr = await r.json();
    this.#messagesReceived += arr.length;
    return arr;
  }

  #startPolling() {
    if (this.#pollerSchedule !== undefined) {
      return;
    }

    let currentPollDelay = 1000;
    let pollerRoutine = async () => {
      let messages = await this.#pollMessages();

      // Do exponential backoff on the polling up to 60 seconds
      currentPollDelay = Math.min(60000, 2 * currentPollDelay);
      for (const message of messages) {
        this.#onDeviceMsgCb(message.payload);
        // There is at least one message, poll sooner
        currentPollDelay = 1000;
      }
      this.#pollerSchedule = setTimeout(pollerRoutine, currentPollDelay);
    };

    this.#pollerSchedule = setTimeout(pollerRoutine, currentPollDelay);
  }
}
