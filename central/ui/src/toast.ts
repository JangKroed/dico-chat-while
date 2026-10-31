type TimerClock={now:()=>number;schedule:(callback:()=>void,delay:number)=>number;cancel:(id:number)=>void;dismiss:()=>void}

// Each start is a new notification, even when its text matches the previous one.
// Pauses can overlap (for example a focused close button under the pointer).
export function createToastTimer(clock:TimerClock) {
  let timer:number|undefined,remaining=0,deadline=0,generation=0,active=false
  const pauses=new Set<string>()
  const cancel=()=>{if(timer!==undefined)clock.cancel(timer);timer=undefined;generation++}
  const arm=()=>{
    if(!active||pauses.size)return
    deadline=clock.now()+remaining
    const current=++generation
    timer=clock.schedule(()=>{
      if(current!==generation||!active||pauses.size)return
      timer=undefined;active=false;clock.dismiss()
    },remaining)
  }
  return {
    start(duration:number){cancel();remaining=duration;active=true;arm()},
    pause(reason:string){
      if(pauses.has(reason))return
      if(!pauses.size&&active){remaining=Math.max(0,deadline-clock.now());cancel()}
      pauses.add(reason)
    },
    resume(reason:string){if(!pauses.delete(reason))return;if(!pauses.size)arm()},
    clear(){cancel();active=false;remaining=0;pauses.clear()}
  }
}
