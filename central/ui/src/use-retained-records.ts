import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {fetchRecordPage,mergeRetainedRecords,type RetainedRecord} from './retained-records'
export function useRetainedRecords<T extends RetainedRecord>(kind:'history'|'logs',latest:T[],filters:Record<string,string>,enabled=true){
  const [stored,setStored]=useState<T[]>([]),[cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('')
  const [refreshKey,setRefreshKey]=useState(0)
  const generation=useRef(0),inFlight=useRef(false),filterKey=JSON.stringify(filters)
  useEffect(()=>{
    const version=++generation.current,controller=new AbortController();setStored([]);setCursor(null);setError('');inFlight.current=false
    if(!enabled){setLoading(false);return()=>controller.abort()}
    setLoading(true)
    const timer=setTimeout(()=>{inFlight.current=true;void fetchRecordPage<T>(kind,JSON.parse(filterKey),undefined,controller.signal).then(page=>{if(generation.current===version){setStored(page.items);setCursor(page.nextCursor)}}).catch(error=>{if(!controller.signal.aborted)setError(error.message)}).finally(()=>{if(generation.current===version){setLoading(false);inFlight.current=false}})},200)
    return()=>{clearTimeout(timer);controller.abort()}
  },[kind,filterKey,enabled,refreshKey])
  const loadMore=useCallback(async()=>{
    if(inFlight.current||!enabled)return
    const version=generation.current;inFlight.current=true;setLoading(true);setError('')
    try{const page=await fetchRecordPage<T>(kind,JSON.parse(filterKey),cursor||undefined);if(version===generation.current){setStored(rows=>mergeRetainedRecords(rows,page.items,kind));setCursor(page.nextCursor)}}catch(error){if(version===generation.current)setError(error instanceof Error?error.message:'기록 조회 실패')}
    finally{if(version===generation.current){inFlight.current=false;setLoading(false)}}
  },[kind,filterKey,cursor,enabled])
  return{records:useMemo(()=>mergeRetainedRecords(stored,latest,kind),[stored,latest,kind]),hasMore:cursor!==null,loading,error,loadMore,reload:()=>setRefreshKey(value=>value+1)}
}
