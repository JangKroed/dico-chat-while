export type ConfirmedBucket = {at:number;confirmed:number;manual?:number;automatic?:number}
export type ChartPoint = {at:number;label:string;count:number;partial:boolean}

/** The service groups confirmations by whole hour. Keep the edge hours when
 * a requested range starts or ends within an hour; their values are partial. */
export function confirmedSeries(buckets:ConfirmedBucket[],from:number,to:number,period:'1h'|'24h'|'7d'):ChartPoint[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to<from) return []
  const points:ChartPoint[]=[]
  if (period==='7d') {
    const start=new Date(from); start.setHours(0,0,0,0)
    for (let day=start.getTime();day<=to;) {
      const next=new Date(day);next.setDate(next.getDate()+1)
      const end=next.getTime()
      points.push({at:day,label:`${new Date(day).getMonth()+1}/${new Date(day).getDate()}`,count:buckets.reduce((sum,b)=>sum+(b.at>=day&&b.at<end?b.confirmed:0),0),partial:day<from||end>to})
      day=end
    }
  } else {
    const hour=3600000
    for(let start=Math.floor(from/hour)*hour;start<=to;start+=hour) {
      const date=new Date(start)
      points.push({at:start,label:`${String(date.getHours()).padStart(2,'0')}시`,count:buckets.reduce((sum,b)=>sum+(b.at===start?b.confirmed:0),0),partial:start<from||start+hour>to})
    }
  }
  return points
}

export function matchesLogLevel(actual:string|undefined,selected:string):boolean {
  if(selected==='all')return true
  const normalized=(value:string)=>value.toLowerCase()==='warning'?'warn':value.toLowerCase()
  return normalized(actual||'info')===normalized(selected)
}
