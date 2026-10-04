import {createRemoteJWKSet, jwtVerify} from 'jose';

/** Configuration is operator supplied, never inferred from request headers or JWT claims. */
export function accessConfiguration({teamDomain, audience, ownerEmail, publicOrigin}={}) {
  let issuer, origin;
  try { issuer=new URL(teamDomain); origin=new URL(publicOrigin); } catch { throw new Error('Access team domain and public origin must be explicit HTTPS origins'); }
  if(issuer.protocol!=='https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) || issuer.port || issuer.username || issuer.password || issuer.pathname!=='/' || issuer.search || issuer.hash) throw new Error('Invalid Cloudflare Access team origin');
  if(origin.protocol!=='https:' || origin.port || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash || !origin.hostname.includes('.')) throw new Error('Invalid dashboard public origin');
  if(typeof audience!=='string' || !audience.trim() || audience!==audience.trim() || audience.length>512) throw new Error('Access application audience is required');
  if(typeof ownerEmail!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('An explicit owner email is required');
  return {issuer:issuer.origin,audience,ownerEmail:ownerEmail.toLowerCase(),publicOrigin:origin.origin};
}

/** All resources, including health and static assets, require a signed owner application JWT.
 * The optional key resolver exists for an embedding host and isolated tests, never a request.
 * Remote public-key requests use jose's timeout/cache/cooldown; no token or cookie is stored or logged.
 */
export function createAccessAuthorizer(configuration,{keyResolver}={}) {
  const {issuer,audience,ownerEmail,publicOrigin}=accessConfiguration(configuration);
  const keys=keyResolver??createRemoteJWKSet(new URL('/cdn-cgi/access/certs',issuer),{timeoutDuration:5000,cooldownDuration:30000,cacheMaxAge:600000});
  const host=new URL(publicOrigin).host;
  return async req=>{
    if(typeof req.headers.host!=='string' || req.headers.host.toLowerCase()!==host) return false;
    const token=req.headers['cf-access-jwt-assertion'];
    if(typeof token!=='string' || token.length>16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
    try {
      const {payload}=await jwtVerify(token,keys,{issuer,audience,algorithms:['RS256'],requiredClaims:['exp','iat','nbf','sub','email','type'],clockTolerance:0});
      if(payload.type!=='app'||!['exp','iat','nbf'].every(key=>Number.isFinite(payload[key]))||typeof payload.sub!=='string'||!payload.sub||typeof payload.email!=='string'||payload.email.toLowerCase()!==ownerEmail) return false;
      return {expiresAt:payload.exp*1000};
    } catch { return false; }
  };
}
