// SCHEMA-ONLY spot check: SQL written reasoning purely from /v1/schema notes.
const U="https://rewind.dinakartumu.com", K="rw_a9055419df2d08161a4619bbf5f89b186a90ef5c";
async function q(sql){const r=await fetch(U+"/v1/query",{method:"POST",headers:{Authorization:"Bearer "+K,"Content-Type":"application/json"},body:JSON.stringify({sql})});return r.json();}
// Each: {id, expected, sql-from-schema}
const picks=[
 {id:"t1-04", expected:["A.R. Rahman",5703],
  // schema: lastfm_artists has name+playcount lifetime; is_filtered=1 hidden -> filter=0
  sql:"SELECT name, playcount FROM lastfm_artists WHERE is_filtered = 0 ORDER BY playcount DESC LIMIT 1"},
 {id:"t2-04", expected:["Drama"],
  // schema: watch_history.movie_id -> movies; movies <- movie_genres <- genres
  sql:"SELECT g.name, COUNT(*) c FROM watch_history w JOIN movie_genres mg ON mg.movie_id=w.movie_id JOIN genres g ON g.id=mg.genre_id GROUP BY g.name ORDER BY c DESC LIMIT 1"},
 {id:"t3-06", expected:["A.R. Rahman",1104],
  // schema: scrobbles -> tracks (filter is_filtered here) -> artists; scrobbled_at ISO text, use substr
  sql:"SELECT a.name, COUNT(*) c FROM lastfm_scrobbles s JOIN lastfm_tracks t ON t.id=s.track_id JOIN lastfm_artists a ON a.id=t.artist_id WHERE t.is_filtered=0 AND strftime('%Y',s.scrobbled_at)='2024' GROUP BY a.id ORDER BY c DESC LIMIT 1"},
 {id:"t4-02", expected:[214],
  // schema: checkins.venue_category, checked_in_at ISO; watch_history.watched_at ISO; join by day
  sql:"SELECT COUNT(DISTINCT date(c.checked_in_at)) FROM checkins c WHERE c.venue_category='Movie Theater' AND date(c.checked_in_at) IN (SELECT date(watched_at) FROM watch_history)"},
 {id:"t4-05", expected:[54],
  // schema: strava_activities.city (nullable); checkins.venue_city; intersect
  sql:"SELECT COUNT(DISTINCT sa.city) FROM strava_activities sa WHERE sa.is_deleted=0 AND sa.city IS NOT NULL AND sa.city IN (SELECT DISTINCT venue_city FROM checkins)"},
];
for(const p of picks){
  const r=await q(p.sql);
  console.log(p.id, "expected", JSON.stringify(p.expected), "=> got", JSON.stringify(r.rows||r.error));
}
