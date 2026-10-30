/** A draft owns the version observed when editing began. Realtime snapshots
 * may display a newer item, but cannot silently change the version it saves. */
export function draftVersion(baseVersion:number|null,latestVersion:number|undefined) {
  if(baseVersion===null)throw Error('Open the item before saving its draft.')
  return {expectedVersion:baseVersion,externalChanged:latestVersion!==undefined&&latestVersion!==baseVersion}
}

export function savedDraftVersion(baseVersion:number):number {
  return baseVersion+1
}
