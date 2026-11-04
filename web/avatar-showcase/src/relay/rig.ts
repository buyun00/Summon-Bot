import { BotEngine, type BotFrame } from '../bot/engine'
import { SHAPE_BY_ID } from '../bot/skins'
import { EXPRESSION_BY_ID } from '../bot/expressions'
import { STATES, type StateId } from '../bot/states'
import { paperShape } from '../../../../capabilities/shared/avatar-style.mjs'

export const motions: Record<string,{duration:number;expression:string;pose:StateId;once?:boolean;fullBody?:boolean}> = {
  idle:{duration:6.4,expression:'neutre',pose:'idle'},
  think:{duration:6.4,expression:'attentif',pose:'idle'},
  work:{duration:4.3,expression:'attentif',pose:'idle'},
  done:{duration:2.8,expression:'heureux',pose:'wink'},
  wait:{duration:6.4,expression:'curieux',pose:'idle'},
  confused:{duration:6.4,expression:'confus',pose:'idle'},
  failed:{duration:6.4,expression:'triste',pose:'idle'},
  asleep:{duration:6.4,expression:'somnolent',pose:'idle'},
}
// The catalogue's silhouettes, particles and rings are real runtime states too.
for (const state of STATES) {
  if (state.id === 'idle') continue
  motions[state.id] = {duration:Math.max(state.duration,state.minDuration||0),expression:'neutre',pose:state.id,
    once:['wink','alert','exclaim','burst','swirl'].includes(state.id),fullBody:!state.baseBody}
}
// Explicit expression states keep the complete picker vocabulary available to branding.
for (const expression of EXPRESSION_BY_ID.keys()) {
  motions['expression:' + expression] = {duration:6.4,expression,pose:'idle'}
}
export class PaperRig {
  engine: BotEngine
  orbit=new BotEngine(100,'orbit')
  motion='idle'
  changed=0
  finished=false
  constructor(shape:string,motion='idle') {
    const spec=motions[motion]||motions.idle!
    this.motion=motions[motion]?motion:'idle'
    this.engine=new BotEngine(100,spec.pose,SHAPE_BY_ID.get(paperShape(shape))!.radii,EXPRESSION_BY_ID.get(spec.expression)!)
  }
  setShape(shape:string,time:number){this.engine.setShape(SHAPE_BY_ID.get(paperShape(shape))!.radii,time)}
  setMotion(motion:string,time:number){
    const next=motions[motion]?motion:'idle';if(next===this.motion)return
    this.motion=next;this.changed=time;this.finished=false
    const spec=motions[next]!
    this.engine.setState(spec.pose,time);this.engine.setExpression(EXPRESSION_BY_ID.get(spec.expression)!,time)
  }
  sample(time:number):BotFrame{
    if(this.motion==='done'&&!this.finished&&time-this.changed>=1.6){this.finished=true;this.engine.setState('idle',time)}
    const frame=this.engine.sample(time)
    if(this.motion==='work')frame.arcs=this.orbit.sample((time-this.changed)%4.3).arcs
    return frame
  }
}
