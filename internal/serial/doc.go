// Package serial owns LinkDeck's serial-port transport.
//
// It wraps go.bug.st/serial v1.8.0 with a small race-safe surface:
// configuration validation, port listing, and open/send/recv/close with
// modem-line status. All errors cross the boundary as Go errors; nothing
// here panics.
//
// Three documented gaps in the underlying library shape this package:
//
//  1. No flow-control API (upstream issue #201: no RTS/CTS or XON/XOFF
//     setting). Mode deliberately exposes no flow-control fields; hardware
//     flow control is out of scope until a device demands it. The manual
//     workaround (SetRTS + GetModemStatusBits polling in app code) remains
//     possible without changing this package's API.
//  2. No hotplug/listen events. Arrival/removal detection must poll List on
//     an app-level ticker (e.g. 1-2 s); List is the poll primitive.
//  3. Close does not unblock a blocked Write (upstream issue #150; blocked
//     reads ARE unblocked via the library's close-signal pipe). Port
//     serializes concurrent Writes with a mutex and rejects new Writes once
//     closed, but an in-flight Write runs to completion: never rely on Close
//     to cancel one, keep writes short and app-serialized.
package serial
