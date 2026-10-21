// Derived from earendil-works/pi v1.3.0 (71023aec1546d6d677a65669c5665c0927ce0dd0).
// Copyright (c) 2025 Mario Zechner. MIT; see third_party/pi/LICENSE and SOURCES.json.
import { EventEmitter } from "node:events";
export function createEventBus() {
    const emitter = new EventEmitter();
    return {
        emit: (channel, data)=>{
            emitter.emit(channel, data);
        },
        on: (channel, handler)=>{
            const safeHandler = async (data)=>{
                try {
                    await handler(data);
                } catch (err) {
                    console.error(`Event handler error (${channel}):`, err);
                }
            };
            emitter.on(channel, safeHandler);
            return ()=>emitter.off(channel, safeHandler);
        },
        clear: ()=>{
            emitter.removeAllListeners();
        }
    };
}
