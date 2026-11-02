// Only the canonical loopback origin works with the runtime's Host/Origin
// checks. Never copy the current fragment, which can contain login material.
export function remoteAccessAddress(href:string):{origin:string;port:string;command:string}|null {
  try{
    const url=new URL(href)
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)return null
    const port=url.port||'80'
    if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)return null
    return {origin:url.origin,port,command:`ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:${port}:127.0.0.1:${port} SSH_USER@CENTRAL_HOST`}
  }catch{return null}
}

export function validRemoteAccessLink(reply:{url:string;expiresAt:number},origin:string,now=Date.now()):boolean {
  try{
    const url=new URL(reply.url)
    return url.origin===origin&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&/^#bootstrap=[a-f0-9]{64}$/.test(url.hash)&&Number.isFinite(reply.expiresAt)&&reply.expiresAt>now
  }catch{return false}
}
