export async function loadSavedData(repository,{fetchImpl=fetch,now=Date.now()}={}) {
  const urls=[`https://raw.githubusercontent.com/${repository}/dashboard-data/data/snapshot.json?t=${Math.floor(now/20000)}`,'./data/snapshot.json'];
  const results=await Promise.allSettled(urls.map(async url=>{
    const response=await fetchImpl(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error('Snapshot unavailable.');
    const data=await response.json();
    if(data.repository?.toLowerCase() !== repository.toLowerCase() || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error('Invalid snapshot.');
    return data;
  }));
  const available=results.filter(r=>r.status === 'fulfilled').map(r=>r.value).sort((a,b)=>Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt));
  if(!available.length) throw new Error('Saved data is unavailable. Please try again shortly.');
  return available[0];
}
