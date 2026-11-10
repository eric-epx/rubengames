/* Ruben Games: connects the pages to the arcade server (the _worker.js file on this same site).
   The game code was first written for Google Apps Script, where pages talk to the server with
   google.script.run.someFunction(...). This recreates that with ordinary web requests to /api. */
(function () {
  'use strict';
  var API_URL = '/api';
  var FUNCS = ['authList', 'authSignUp', 'authSignIn', 'authMe', 'authChangePassword',
               'lbInit', 'lbBoard', 'lbSetName', 'lbStartRun', 'lbSubmitScore',
               'apStatus', 'apLogin', 'apData', 'apRename', 'apDelete', 'apEraseAll', 'apChangePassword', 'apImport'];
  function call(fn, args, ok, fail) {
    fetch(API_URL, { method: 'POST', credentials: 'same-origin', body: JSON.stringify({ fn: fn, args: args }),
                     headers: { 'Content-Type': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { if (ok) ok(j.result); }
        else if (fail) fail(new Error((j && j.error) || 'Something went wrong. Please try again.'));
      }, function () {
        if (fail) fail(new Error('Couldn\'t reach the Ruben Games server. Check your internet connection and try again.'));
      });
  }
  function runner(ok, fail) {
    var r = {
      withSuccessHandler: function (f) { return runner(f, fail); },
      withFailureHandler: function (f) { return runner(ok, f); }
    };
    FUNCS.forEach(function (fn) {
      r[fn] = function () { call(fn, Array.prototype.slice.call(arguments), ok, fail); };
    });
    return r;
  }
  window.google = window.google || {};
  window.google.script = { run: runner(null, null) };
})();
