# xdev-link

The end-to-end encrypted link between xDev and the computers and phones paired with it: one identity key, one pairing flow, one peer store and one RPC channel.

No Tauri, no async runtime and no license logic. The desktop glue (`apps/desktop/src-tauri/src/peers`) owns those.

## Modules

| module | what |
|---|---|
| `identity` | `HostKey` (X25519) in the OS keyring (`xdev` / `remote-host-key`), `host_id` (b64url sha256[..16]), fingerprint `XXXX-XXXX-XXXX-XXXX` |
| `offer` | `PairOffer` ↔ `xdev://pair?d=`, `PairCode` (10 Crockford base32 characters), `PairWindow` (single use, 5 min, 5 failures) |
| `noise` | XXpsk3 and IK over `snow`, prologue `xdev-link/1`, the 6-digit SAS |
| `frame` | JSON `{id?,m,p}` / `{id,r}` / `{id,e}`, stream frames `[0x01][u32 BE id][bytes]` |
| `peers` | `peers.json`; reads the older `scope` field as a role |
| `limits`, `backoff`, `net`, `discovery` | rate limits, reconnect delays, candidate addresses, mDNS `_xdev-link._tcp.local.` |
| `server`, `dial`, `link` | the listener, the dialer, and an established session |

## Wire

The dialer's first message starts with one byte:

| byte | pattern | psk |
|---|---|---|
| `0x10` | XXpsk3 | BLAKE2s(`xdev-pair-v1` ‖ code) |
| `0x11` | IK | none, the dialer is already paired |
| `0x12` | XXpsk3 | the offer secret (a phone that scanned the link) |

Each later handshake message begins with `0x00` followed by a Noise message, or `0xEE` followed by a plaintext error code (`pair_code`, `pair_busy`, `pair_rejected`, `peer_denied`). Once the link is up, messages are bare Noise transport messages.

The pairing sequence:

1. XXpsk3, message 1.
2. Message 2 carries `{n}`, the host name.
3. Message 3 carries `{n, k}`, the joiner's name and kind.

A wrong code fails the third message on the host, so the joiner gets `pair_code` before any SAS shows.

After that:

1. The host sends `pair.ready`.
2. Both sides compare the SAS.
3. The joiner sends `pair.confirm{accept}`.
4. The host waits up to 120 s for `Handle::confirm`, then sends `pair.result{accept}`.
5. The connection closes. Later connections use IK.

An IK dialer whose key is not in the store gets `peer_denied` before the host writes message 2, so no app data is exchanged.

## Choices

- **`snow`** for Noise. Its BLAKE2s resolver also computes the code's psk, so the crate takes no direct `blake2` dependency.
- **`tungstenite`** with only the `handshake` feature: a sync WebSocket, no TLS (Noise does the encryption).
- **`if-addrs`** to list LAN and Tailscale (100.64.0.0/10) addresses for offers.
- **`mdns-sd`** for discovery. It runs its own thread, so there is no async runtime. Discovery is off when the listener binds to localhost. The TXT record carries `n=<name>` only while pairing is open.
- **`e`** in the offer JSON is Unix milliseconds.
- **`Duplex::set_read_timeout`**: the relay's byte stream has to support a read timeout, so a single IO thread can both read and write it.

## Logging

This crate does not log. Its `Debug` impls and error messages never include codes, psks, keys, plaintext or stream bytes.

## Tests

`cargo test -p xdev-link` runs every handshake and link test over in-memory pipes (`mem`, also exported with the `test-util` feature), so they use no sockets.
