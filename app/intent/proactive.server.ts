// Proactive decision layer. Reimplemented as the gated decision engine in
// ./proactive/* (spec: Proactive Popup Decision Engine). This file is the stable
// import surface for routes; all logic lives in the subsystem.
export { decideProactive, onDismiss, onEngage, isHoldout } from "./proactive/engine";
export type { ProactiveResult } from "./proactive/engine";
