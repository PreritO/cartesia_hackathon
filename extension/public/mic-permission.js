const statusEl = document.getElementById('status');
navigator.mediaDevices.getUserMedia({ audio: true })
  .then(function(stream) {
    stream.getTracks().forEach(function(t) { t.stop(); });
    statusEl.textContent = 'Mic access granted! Closing...';
    statusEl.className = 'success';
    setTimeout(function() { window.close(); }, 800);
  })
  .catch(function() {
    statusEl.textContent = 'Permission denied. Please click the mic icon in the address bar to allow, then close this tab.';
    statusEl.className = 'error';
  });
