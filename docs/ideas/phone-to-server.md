# A phone straight to a server

Status: idea, not approved. Today a phone reaches a server only through
a desktop, which relays it (docs/remote.md, "Servers").

The phone would connect the way the desktop does, `ssh host termic-server
bridge`, with its own key: no new port on the box. Pairing goes through
the desktop, which already has ssh: the phone makes a key (Keychain), and
the desktop adds its public half to the box's `authorized_keys` with a
forced command, `command="~/.termic/bin/termic-server bridge",
no-port-forwarding,no-pty`, so the key can do nothing but talk to
termic-server. Unpairing deletes that line. A QR printed by the server
was considered and dropped: it needs a network listener and a pairing
store on the box, more to protect for nothing sshd does not already give.

What keeps it possible, all cheap now:

1. ssh + `bridge` stays the only way into a server.
2. The box serves a client with no desktop: daemon-owned PTYs,
   hooks on the box, the queued-prompt drain.
3. Task creation is the desktop's (`TaskHost` over `exec`), so a phone
   creating a task on a box needs the desktop's rules carried there, or
   that code shared as a crate.
4. Names, groups and pins are on the box (done), so a direct
   client sees the desktop's organisation.
5. One stream host (done), so the box speaks the phone's protocol with
   the desktop's code.
6. Pairing records leave room for "a phone's key on server X".
