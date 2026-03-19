# Web3270

## Goal

Run a 3270 mainframe terminal directly in the browser — no desktop emulator required. The server spawns `c3270` on demand and pipes its I/O to the browser over a WebSocket.

## How dynamic connections work

When a browser connects, no `c3270` process is started yet. The frontend first picks a server, then emits:

```js
socket.on('connect_to_mainframe', (payload) => {
    // payload = { id, cols, rows }
    // server looks up hostname/port/user from mainframes.json
    // spawns c3270 and pipes I/O back to the socket
});
```

This means one Node process can serve connections to multiple different mainframes simultaneously — each socket gets its own `c3270` child process, spawned with the right configuration for the chosen server.

## Why this enables a proper dashboard

Because the connection is driven by a socket event, the frontend is free to show anything before connecting: a list of servers, a recent sessions panel, environment indicators. The user clicks a server card, the frontend emits `connect_to_mainframe`, and the terminal session starts instantly in the same page.

Credentials and host details never reach the browser — the client only sends an `id`. The server resolves the full configuration, including env-var substitution (`$VAR` / `${VAR}`) at connect time.
