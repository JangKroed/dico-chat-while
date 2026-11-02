import type {AccessMode} from './api'
export function lanLoginRequired(mode:AccessMode|null,auth:string){return mode==='lan'&&auth==='unauthorized'}
export function normalizePairingCode(value:string){return value.replaceAll('-','').replaceAll(' ','').trim().toUpperCase()}
export function validPairingCode(value:string){return /^[A-F0-9]{12}$/.test(normalizePairingCode(value))}
export function lanPort(value:string){const port=Number(value);return Number.isInteger(port)&&port>=1024&&port<=65535?port:null}
