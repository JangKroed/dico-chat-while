import {useEffect} from 'react'
import {installDialogAccessibility} from './dialog-focus'
export function DialogAccessibility(){
 useEffect(()=>installDialogAccessibility(document),[])
 return null
}
