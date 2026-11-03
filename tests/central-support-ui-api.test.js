import test from 'node:test';
import assert from 'node:assert/strict';
import {establishSession,getSupportReport,inspectSupportReport,ApiError} from '../central/ui/src/api.ts';

test('support exports encode only requested scope and inspection uses the authenticated CSRF session',async()=>{
  const oldFetch=globalThis.fetch,oldLocation=globalThis.location,calls=[];
  globalThis.location={hash:'',pathname:'/settings',search:''};
  const report={format:'dico-support-report',schemaVersion:1,reportId:'r'};
  globalThis.fetch=async(path,init)=>{
    calls.push({path,init});
    if(path==='/api/session')return Response.json({csrfToken:'session-proof'});
    if(path==='/api/support/inspect')return Response.json({report,summary:{attempts:0},findings:[]});
    return Response.json(report);
  };
  try{
    await establishSession();
    await getSupportReport({attemptId:'a&other=1',includeBodies:false,includeNames:true});
    const url=new URL(calls[1].path,'http://127.0.0.1');assert.equal(url.pathname,'/api/support/report');assert.equal(url.searchParams.get('attemptId'),'a&other=1');assert.equal(url.searchParams.get('other'),null);assert.equal(url.searchParams.get('includeBodies'),'false');assert.equal(url.searchParams.get('includeNames'),'true');
    await getSupportReport({from:100,to:200,includeBodies:true,includeNames:false});
    const range=new URL(calls[2].path,'http://127.0.0.1');assert.equal(range.searchParams.get('from'),'100');assert.equal(range.searchParams.get('to'),'200');assert.equal(range.searchParams.get('attemptId'),null);
    const result=await inspectSupportReport(report);assert.equal(result.report.reportId,'r');
    const sent=calls[3];assert.equal(sent.init.method,'POST');assert.equal(sent.init.credentials,'same-origin');assert.equal(sent.init.headers.get('X-Dico-CSRF'),'session-proof');assert.deepEqual(JSON.parse(sent.init.body),{report});
  }finally{globalThis.fetch=oldFetch;globalThis.location=oldLocation;}
});

test('support failures retain authorization errors instead of offering an incomplete export',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>Response.json({error:{code:'UNAUTHORIZED',message:'세션 만료'}},{status:401});
  try{await assert.rejects(()=>getSupportReport({includeBodies:true,includeNames:true}),error=>error instanceof ApiError&&error.status===401&&error.message==='세션 만료');}finally{globalThis.fetch=previous;}
});
