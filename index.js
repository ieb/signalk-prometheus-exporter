/*
 * Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Bacon = require('baconjs')
const debug = require('debug')('signalk-prometheus-exporter')
const util = require('util')

module.exports = function (app) {
  const logError = app.error || ((err) => {console.error(err)})
  let selfContext = 'vessels.' + app.selfId
  let store = {};

  let unsubscribes = []
  let shouldStore = function (path) {
    return true
  }
  let lfMetric = function (path) {
    return false
  }

  function toPromKey(v) {
    return v.replace(/-|\./g,"_");
  }

  function toMetrics(store, lf) {
      var r = ""
      for (var v in store) {
        if (lfMetric(v) != lf) { continue };
        var k = toPromKey(v);
        r = r + "# HELP "+k+" "+v+"\n";
        r = r + "# TYPE "+k+" gauge\n";
        r = r + k + " " + store[v] + "\n";
      } 
      return r;
  }
  function checkAndStore(key, value, store) {
    if (typeof value === 'number' && !isNaN(value)) {
      store[key] = value;
    }
  }
  function saveDelta(delta, checkShouldStore, store) {
      if (delta.context === 'vessels.self') {
        delta.context = selfContext
      }
      if (delta.updates && delta.context === selfContext) {
        delta.updates.forEach(update => {
          if (update.values) {
            for (var i = update.values.length - 1; i >= 0; i--) {
              var path = update.values[i].path;
              var value = update.values[i].value;
              if (shouldStore(path)) {
                if (path === 'navigation.position') {
                  checkAndStore(path+'.longitude', value.longitude, store);
                  checkAndStore(path+'.latitude', value.latitude, store);
                } else if (path === 'navigation.attitude') {
                  checkAndStore(path+'.pitch', value.pitch, store);
                  checkAndStore(path+'.roll', value.roll, store);
                  checkAndStore(path+'.yaw', value.roll, store);
                } else if (path === 'environment.current') {
                  checkAndStore(path+'.setTrue', value.setTrue, store);
                  checkAndStore(path+'.drift', value.drift, store);
                } else {
                  checkAndStore(path, value, store);
                }
              }
            }
          }
        });
      }      
  }


  return {
    id: 'signalk-prometheus-exporter',
    name: 'Prometheus exporter for SignalK',
    description: 'Signal K server plugin exposes a end point for Prometheus to pull from',

    schema: {
      type: 'object',
      required: [],
      properties: {
        blackOrWhite: {
          type: 'string',
          title: 'Type of List',
          description:
            'With a blacklist, all numeric values except the ones in the list below will be stored in InfluxDB. With a whitelist, only the values in the list below will be stored.',
          default: 'Black',
          enum: ['White', 'Black']
        },
        blackOrWhitelist: {
          title: 'SignalK Paths',
          description:
            'A list of SignalK paths to be exluded or included based on selection above',
          type: 'array',
          items: {
            type: 'string',
            title: 'Path'
          }
        },
        lowFrequencyMetrics: {
          type: 'array',
          title: 'Any SignalK metric matching any of these RegExps will be published on /lf',
          type: 'array',
          items: {
            type: 'string',
            title: 'Regex'
           }
        }
       }
    },
    start: function (options) {
      {
        // Set up Low Frequency filter
        var lf = []
        options.lowFrequencyMetrics.forEach(element => {
          try {
            lf.push(new RegExp(element));
          } catch (err) {
            console.error("Cannot use '" + element + "' for a regular expression", err);
          };
        });

        lfMetric = function (name) {
          for (const r of lf) {
            if (r.test(name)) {
              return true;
	    }
	  };
          return false;
        }
      }
      if (
        typeof options.blackOrWhitelist !== 'undefined' &&
        typeof options.blackOrWhite !== 'undefined' &&
        options.blackOrWhitelist.length > 0
      ) {
        var obj = {}

        options.blackOrWhitelist.forEach(element => {
          obj[element] = true
        })

        if (options.blackOrWhite == 'White') {
          shouldStore = function (path) {
            return typeof obj[path] !== 'undefined'
          }
        } else {
          shouldStore = function (path) {
            return typeof obj[path] === 'undefined'
          }
        }
      }
      var handleDelta = function(delta) {
        saveDelta(delta, shouldStore, store);
      }
      app.signalk.on('delta', handleDelta)
      unsubscribes.push(() => {
        app.signalk.removeListener('delta', handleDelta)
      })
    },
    stop: function () {
      unsubscribes.forEach(f => f())
      store = {};
    },
    signalKApiRoutes: function (router) {
      const metricsHandler = function(req, res, next) {
        res.type("text/plain; version=0.0.4; charset=utf-8");
        res.send(toMetrics(store, false));
      }
      router.get('/prometheus', metricsHandler);
      const metricsHandlerLF = function(req, res, next) {
        res.type("text/plain; version=0.0.4; charset=utf-8");
        res.send(toMetrics(store, true));
      }
      router.get('/prometheus/lf', metricsHandlerLF);
      console.log("Registered metrics end point ", router );
      return router;
    }
  }
}

