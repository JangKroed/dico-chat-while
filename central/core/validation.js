export class CentralError extends Error {
  constructor(code,message,status=400){super(message);this.name='CentralError';this.code=code;this.status=status;}
}
export function requireValue(ok,code,message,status=400){if(!ok)throw new CentralError(code,message,status);}
export function text(value,name,max=200){requireValue(typeof value==='string'&&value.trim().length>0&&value.length<=max,'VALIDATION',`${name} must contain 1–${max} characters.`);return value.trim();}
export function body(value){requireValue(typeof value==='string'&&value.trim().length>0&&value.length<=2000&&!/@(?:everyone|here)\b|<@&\d+>/iu.test(value),'VALIDATION','Message requires 1–2,000 characters and cannot contain everyone, here, or role mentions.');return value;}
export function duration(value,name='intervalMs'){requireValue(Number.isSafeInteger(value)&&value>=0&&value<=31_536_000_000,'VALIDATION',`${name} must be a non-negative duration in milliseconds.`);return value;}
export function tags(value=[]){requireValue(Array.isArray(value)&&value.length<=30,'VALIDATION','Use at most 30 tags.');return [...new Set(value.map(v=>text(v,'tag',40)))];}
export function expected(entity,payload){requireValue(payload.expectedVersion===entity.version,'VERSION_CONFLICT','This item changed. Reload its latest version before saving.',409);}
