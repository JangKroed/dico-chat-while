// Keep keyboard navigation within the active dialog without changing its data.
export function nextDialogFocus<T>(items:T[],active:T|null,backward:boolean):T|null {
 if(!items.length)return null
 const index=active===null?-1:items.indexOf(active)
 if(index===-1)return backward?items.at(-1)!:items[0]
 if(backward&&index===0)return items.at(-1)!
 if(!backward&&index===items.length-1)return items[0]
 return null
}
export function installDialogAccessibility(doc:Document){
 let current:HTMLElement|null=null,restoreTo:HTMLElement|null=null,lastOutside:HTMLElement|null=doc.activeElement instanceof HTMLElement&&!doc.activeElement.closest('.modal-backdrop')?doc.activeElement:null
 let inerted:{node:HTMLElement;wasInert:boolean}[]=[],overflow=''
 const release=()=>{
  for(const {node,wasInert} of inerted)node.inert=wasInert
  inerted=[]
  if(current)doc.body.style.overflow=overflow
  current=null
  if(restoreTo?.isConnected)restoreTo.focus()
  restoreTo=null
 }
 const focusables=(modal:HTMLElement)=>[...modal.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')].filter(node=>node.tabIndex!==-1&&!node.matches(':disabled')&&!node.closest('[hidden],[inert]')&&node.getClientRects().length>0)
 const sync=()=>{
  const modal=[...doc.querySelectorAll<HTMLElement>('.modal-backdrop .modal[role="dialog"]')].at(-1)||null
  if(modal===current)return
  release()
  if(!modal)return
  current=modal;restoreTo=lastOutside;overflow=doc.body.style.overflow;doc.body.style.overflow='hidden'
  let node:HTMLElement|null=modal.closest<HTMLElement>('.modal-backdrop')
  while(node&&node!==doc.body){
   for(const sibling of node.parentElement?.children||[])if(sibling!==node&&sibling instanceof HTMLElement){inerted.push({node:sibling,wasInert:sibling.inert});sibling.inert=true}
   node=node.parentElement
  }
  if(!modal.contains(doc.activeElement)){
   modal.tabIndex=-1;(focusables(modal)[0]||modal).focus()
  }
 }
 const focus=(event:FocusEvent)=>{if(event.target instanceof HTMLElement&&!event.target.closest('.modal-backdrop'))lastOutside=event.target}
 const pointer=(event:PointerEvent)=>{if(event.target instanceof Element&&!event.target.closest('.modal-backdrop')){const trigger=event.target.closest<HTMLElement>('button,a[href],summary,[tabindex]');if(trigger)lastOutside=trigger}}
 const key=(event:KeyboardEvent)=>{
  if(!current||event.defaultPrevented)return
  if(event.key==='Escape'){
   event.preventDefault();event.stopPropagation();current.closest<HTMLElement>('.modal-backdrop')?.click();return
  }
  if(event.key!=='Tab')return
  const items=focusables(current),target=nextDialogFocus(items,doc.activeElement as HTMLElement|null,event.shiftKey)
  if(!items.length){event.preventDefault();current.focus()}
  else if(target){event.preventDefault();target.focus()}
 }
 doc.addEventListener('pointerdown',pointer,true);doc.addEventListener('focusin',focus);doc.addEventListener('keydown',key,true)
 const observer=new MutationObserver(sync);observer.observe(doc.body,{childList:true,subtree:true});sync()
 return()=>{observer.disconnect();doc.removeEventListener('pointerdown',pointer,true);doc.removeEventListener('focusin',focus);doc.removeEventListener('keydown',key,true);release()}
}
