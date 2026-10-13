// Use NODE_OPTIONS=--import=<absolute path> for all tests and their child processes.
// Test-local fetch mocks remain usable; every actual socket connection fails closed.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const blocked = () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
globalThis.fetch = async () => blocked();
http.request = http.get = https.request = https.get = blocked;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
