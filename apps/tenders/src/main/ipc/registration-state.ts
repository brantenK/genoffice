// Whether the Tenders IPC surface has been registered in this process.
//
// One boolean, in its own module because two parties need it and neither should
// have to import the other: `registerTendersIpc` (which sets it) and
// `resetTendersIpcForTests` / `isTendersIpcRegisteredForTests` (which clear and
// read it). Keeping it here is what lets the handler registry and the composition
// root stay free of a cycle.
let ipcRegistered = false

export function isTendersIpcRegistered(): boolean {
  return ipcRegistered
}

export function markTendersIpcRegistered(): void {
  ipcRegistered = true
}

export function clearTendersIpcRegistered(): void {
  ipcRegistered = false
}
