export type Appearance = 'system'|'light'|'dark'
export const APPEARANCE_KEY='dico.appearance'
const valid=(value:unknown):Appearance=>value==='light'||value==='dark'?value:'system'
type Environment={root:Pick<HTMLElement,'dataset'|'style'>;storage?:Pick<Storage,'getItem'|'setItem'>;media:Pick<MediaQueryList,'matches'|'addEventListener'|'removeEventListener'>}
export function createAppearanceController({root,storage,media}:Environment) {
  let selection:Appearance='system'
  try{selection=valid(storage?.getItem(APPEARANCE_KEY))}catch{/* Restricted storage still permits an in-memory choice. */}
  const listeners=new Set<()=>void>()
  const apply=()=>{
    const resolved=selection==='system'?(media.matches?'dark':'light'):selection
    root.dataset.theme=resolved;root.style.colorScheme=resolved
  }
  const systemChanged=()=>{if(selection==='system')apply()}
  media.addEventListener('change',systemChanged)
  apply()
  return {
    get:()=>selection,
    set:(next:Appearance)=>{
      selection=valid(next);apply()
      try{storage?.setItem(APPEARANCE_KEY,selection)}catch{/* Keep the selected theme for this session. */}
      for(const listener of listeners)listener()
    },
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
    dispose:()=>{media.removeEventListener('change',systemChanged);listeners.clear()}
  }
}
let controller:ReturnType<typeof createAppearanceController>|undefined
export function initializeAppearance() {
  if(!controller){
    let storage:Storage|undefined
    try{storage=window.localStorage}catch{/* Storage access itself may throw. */}
    const media=typeof window.matchMedia==='function'?window.matchMedia('(prefers-color-scheme: dark)'):{matches:false,addEventListener:()=>{},removeEventListener:()=>{}}
    controller=createAppearanceController({root:document.documentElement,storage,media})
  }
  return controller
}
export const getAppearance=()=>initializeAppearance().get()
export const setAppearance=(next:Appearance)=>initializeAppearance().set(next)
export const subscribeAppearance=(listener:()=>void)=>initializeAppearance().subscribe(listener)
