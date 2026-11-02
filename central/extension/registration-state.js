// Tag assignments, not Discord tabs. A delayed pre-reset storage write must
// never make an old account/window a managed connection in the new generation.
export function currentRegistration(saved,resetEpoch=0){
 const current=value=>value&&(value.resetEpoch??0)===resetEpoch;
 return{dicoCentralAccount:current(saved?.dicoCentralAccount)?saved.dicoCentralAccount:null,dicoCentralTabs:(saved?.dicoCentralTabs||[]).filter(current)};
}
