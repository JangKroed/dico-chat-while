// Recent records within a byte/count budget. Originals in the store are untouched.
export function supportRecordBuffer({maxBytes=1024*1024,maxRecords=2500}={}) {
 let entries=[],head=0,bytes=0,total=0;
 return {
  add(record){
   total++;const size=Buffer.byteLength(JSON.stringify(record));
   if(size>maxBytes)return;
   entries.push({record,size});bytes+=size;
   while(bytes>maxBytes||entries.length-head>maxRecords){bytes-=entries[head++].size;}
   if(head>1000){entries=entries.slice(head);head=0;}
  },
  values(){return entries.slice(head).map(entry=>entry.record);},
  get omitted(){return total-(entries.length-head);}
 };
}
