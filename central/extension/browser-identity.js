// Brave shares Chrome's UA. Prefer its explicit browser API before UA brands.
export async function detectBrowser(nav=globalThis.navigator) {
  if(typeof nav?.brave?.isBrave==='function') {
    try{if(await nav.brave.isBrave())return 'Brave';}catch{return 'Chromium';}
  }
  const brands=(nav?.userAgentData?.brands||[]).map(item=>item.brand);
  const ua=nav?.userAgent||'';
  if(brands.includes('Microsoft Edge')||/Edg\//.test(ua))return 'Edge';
  if(brands.includes('Opera')||/OPR\//.test(ua))return 'Opera';
  if(/Vivaldi\//.test(ua))return 'Vivaldi';
  if(brands.includes('Brave'))return 'Brave';
  if(brands.includes('Google Chrome'))return 'Chrome';
  return 'Chromium';
}

export async function detectConnectedBrowser(chrome,nav=globalThis.navigator) {
  const direct=await detectBrowser(nav);
  if(direct==='Brave'||direct==='Edge'||direct==='Opera'||direct==='Vivaldi')return direct;
  // Some Chromium workers omit the vendor API. A host-permitted Discord tab
  // provides a second isolated-world observation without reading account data.
  try {
    const tabs=await chrome.tabs.query({url:'https://discord.com/*'});
    const tab=tabs.find(item=>Number.isInteger(item.id));
    if(tab){const results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:detectBrowser});const observed=results[0]?.result;
      if(['Brave','Chrome','Edge','Opera','Vivaldi'].includes(observed))return observed;
    }
  }catch{ /* No readable Discord tab; keep the explicit worker evidence. */ }
  return direct;
}
