import type {Channel,Group,Snapshot} from './api'

export type OrderedChannelAccount={bindingId:string;binding:Channel|undefined;order:number;current:boolean}
export function channelAccountOrder(s:Pick<Snapshot,'channels'|'groups'>,target:Pick<Channel,'guildId'|'channelId'>) {
  const bindings=s.channels.filter(c=>c.guildId===target.guildId&&c.channelId===target.channelId)
  const byId=new Map(bindings.map(binding=>[binding.id,binding])),assigned=new Set<string>()
  const groups=s.groups.filter(g=>g.guildId===target.guildId&&g.channelId===target.channelId).map((group:Group)=>{
    const currentIndex=Number.isInteger(group.cursor)&&group.cursor>=0?group.cursor%Math.max(1,group.members.length):-1
    const entries:OrderedChannelAccount[]=group.members.map((bindingId,index)=>{
      assigned.add(bindingId)
      return {bindingId,binding:byId.get(bindingId),order:index+1,current:index===currentIndex}
    })
    return {group,entries}
  })
  return {bindings,groups,ungrouped:bindings.filter(binding=>!assigned.has(binding.id))}
}
