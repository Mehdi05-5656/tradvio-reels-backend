// Exact provider identity reconciliation, never a time/caption similarity join.
export function publishedIdentity(post:any,requestedId:string,accountId:string){
  if(!post||post.account_id!==accountId||post.state!=="published"||
    !["string","number"].includes(typeof post.id)||!String(post.id).match(/^[A-Za-z0-9_-]{1,128}$/))
    throw new Error("publication_not_confirmed");
  const ids=[post.id,post.old_id].filter(x=>typeof x==="string"||typeof x==="number").map(String);
  if(!ids.includes(requestedId))throw new Error("publication_identity_mismatch");
  if(typeof post.post_link!=="string"||typeof post.post_id!=="string")
    throw new Error("publication_link_missing");
  const url=new URL(post.post_link);
  if(url.protocol!=="https:"||url.username||url.password||url.port)
    throw new Error("publication_link_invalid");
  if(post.account_type!=="tiktok"||!["www.tiktok.com","tiktok.com"].includes(url.hostname)
    ||!/^\/@[^/]+\/video\/[0-9]+\/?$/.test(url.pathname)
    ||url.pathname.split("/").filter(Boolean).at(-1)!==post.post_id)
    throw new Error("publication_link_invalid");
  url.search="";url.hash="";
  return {provider_post_id:String(post.id),legacy_post_id:post.old_id??null,
    platform_post_id:post.post_id,account_id:accountId,
    provider_permalink:post.post_link,canonical_permalink:url.toString(),
    verification:"provider_exact_id_readback" as const};
}
