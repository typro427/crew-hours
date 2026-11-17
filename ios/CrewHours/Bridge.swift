import Foundation

/// Put into every page before it runs: tells the crew app it's inside the iPhone app (window.CrewHoursNative),
/// and answers navigator.geolocation from the phone's GPS (LocationBridge), which keeps working with the phone locked.
enum Bridge {
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0" }

    static var script: String { """
    (function(){
      if (window.CrewHoursNative) return;
      function post(m){ try { window.webkit.messageHandlers.native.postMessage(m); } catch (e) {} }
      var watches = {}, next = 1, once = [];
      function each(list, fn){ list.forEach(function(w){ try { fn(w); } catch (e) {} }); }
      function all(){ return Object.keys(watches).map(function(k){ return watches[k]; }); }
      window.CrewHoursNative = {
        platform: 'ios', version: '\(version)', post: post, onPush: null,
        _pos: function(p){
          var pos = { coords: { latitude: p.lat, longitude: p.lon, accuracy: p.acc, altitude: p.alt, altitudeAccuracy: null, heading: p.hdg, speed: p.spd }, timestamp: p.t };
          each(all(), function(w){ w.ok(pos); });
          var o = once; once = []; each(o, function(w){ w.ok(pos); });
        },
        _err: function(code, message){
          var e = { code: code, message: message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
          each(all(), function(w){ if (w.err) w.err(e); });
          var o = once; once = []; each(o, function(w){ if (w.err) w.err(e); });
        },
        _push: function(r){ if (window.CrewHoursNative.onPush) window.CrewHoursNative.onPush(r); }
      };
      if (navigator.geolocation) {
        var g = navigator.geolocation;
        g.watchPosition = function(ok, err, opts){ var id = next++; watches[id] = { ok: ok, err: err }; post({ type: 'geo.watch', id: id }); return id; };
        g.clearWatch = function(id){ if (watches[id]) { delete watches[id]; post({ type: 'geo.clear', id: id }); } };
        g.getCurrentPosition = function(ok, err){ once.push({ ok: ok, err: err }); post({ type: 'geo.once' }); };
      }
    })();
    """ }
}
