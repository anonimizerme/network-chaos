(() => {
  const byId = (id) => document.getElementById(id);
  const startButton = byId('start');
  const stopButton = byId('stop');
  const status = byId('status');
  const peerRows = document.querySelectorAll('[data-peer]');
  const flowRows = document.querySelectorAll('[data-flow]');
  let call;

  function showOnline() {
    byId('online').textContent = String(navigator.onLine);
  }
  window.addEventListener('online', showOnline);
  window.addEventListener('offline', showOnline);
  showOnline();

  function renderRow(row, values) {
    for (const cell of row.querySelectorAll('[data-stat]')) {
      cell.textContent = values[cell.dataset.stat] ?? '—';
    }
  }

  function toMilliseconds(seconds) {
    return Number.isFinite(seconds) ? (seconds * 1000).toFixed(2) : undefined;
  }

  function packetDelta(current, previous, field) {
    if (!current || !previous || current.id !== previous.id) return undefined;
    const delta = current[field] - previous[field];
    return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
  }

  async function sample(session) {
    const readings = await Promise.all(session.peers.map(async (peer) => {
      const report = await peer.getStats();
      const stats = [...report.values()];
      const inbound = stats.find((entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio');
      const outbound = stats.find((entry) => entry.type === 'outbound-rtp' && entry.kind === 'audio');
      const transport = stats.find((entry) => entry.type === 'transport');
      const pair = report.get(transport?.selectedCandidatePairId);
      return {
        inbound,
        outbound,
        connectionState: peer.connectionState,
        iceConnectionState: peer.iceConnectionState,
        signalingState: peer.signalingState,
        rtt: toMilliseconds(pair?.currentRoundTripTime),
        protocol: report.get(pair?.localCandidateId)?.protocol,
      };
    }));
    if (call !== session) return;
    readings.forEach((reading, index) => {
      renderRow(peerRows[index], reading);
      const outbound = reading.outbound;
      const inbound = readings[1 - index].inbound;
      renderRow(flowRows[index], {
        packetsSent: outbound?.packetsSent,
        deltaSent: packetDelta(outbound, session.previous?.[index].outbound, 'packetsSent'),
        packetsReceived: inbound?.packetsReceived,
        deltaReceived: packetDelta(inbound, session.previous?.[1 - index].inbound, 'packetsReceived'),
        packetsLost: inbound?.packetsLost,
        bytesSent: outbound?.bytesSent,
        bytesReceived: inbound?.bytesReceived,
        jitter: toMilliseconds(inbound?.jitter),
      });
    });
    session.previous = readings;
    session.timer = setTimeout(() => sample(session).catch((error) => failCall(session, error)), 1000);
  }

  function stopCall() {
    if (!call) return;
    const session = call;
    call = undefined;
    clearTimeout(session.timer);
    for (const peer of session.peers) peer.close();
    session.context?.close();
    for (const row of [...peerRows, ...flowRows]) renderRow(row, {});
    startButton.disabled = false;
    stopButton.disabled = true;
    status.className = '';
    status.textContent = 'Звонок остановлен';
  }

  function failCall(session, error) {
    if (call !== session) return;
    stopCall();
    status.className = 'error';
    status.textContent = error.message;
  }

  startButton.addEventListener('click', async () => {
    const session = { peers: [] };
    call = session;
    startButton.disabled = true;
    stopButton.disabled = false;
    status.className = '';
    status.textContent = 'Запуск звонка…';

    try {
      const context = new AudioContext();
      session.context = context;
      const oscillator = context.createOscillator();
      const audio = context.createMediaStreamDestination();
      oscillator.connect(audio);
      oscillator.start();
      await context.resume();
      if (call !== session) return;

      session.peers.push(new RTCPeerConnection());
      session.peers.push(new RTCPeerConnection());
      const [a, b] = session.peers;
      const candidates = new Map([[a, []], [b, []]]);
      for (const [local, remote] of [[a, b], [b, a]]) {
        local.addTrack(audio.stream.getAudioTracks()[0], audio.stream);
        local.onicecandidate = ({ candidate }) => {
          if (!candidate || call !== session) return;
          if (remote.remoteDescription) {
            remote.addIceCandidate(candidate).catch((error) => failCall(session, error));
          } else {
            candidates.get(remote).push(candidate);
          }
        };
      }

      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      await b.setRemoteDescription(offer);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);
      for (const [peer, pending] of candidates) {
        await Promise.all(pending.map((candidate) => peer.addIceCandidate(candidate)));
      }
      if (call !== session) return;
      status.className = 'ok';
      status.textContent = 'Звонок запущен';
      await sample(session);
    } catch (error) {
      failCall(session, error);
    }
  });
  stopButton.addEventListener('click', stopCall);

  const wsStart = byId('websocket-start');
  const wsStop = byId('websocket-stop');
  const wsStatus = byId('websocket-status');
  const wsSent = byId('websocket-sent');
  const wsReceived = byId('websocket-received');
  let socket;

  byId('websocket-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (socket) return;
    let connection;
    try {
      const url = new URL(byId('websocket-url').value);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Укажите адрес ws:// или wss://');
      connection = new WebSocket(url);
    } catch (error) {
      wsStatus.textContent = error.message;
      return;
    }
    socket = connection;
    let timer;
    let sent = 0;
    let received = 0;
    const prefix = `network-chaos:${Date.now()}:`;
    wsStart.disabled = true;
    wsStop.disabled = false;
    wsStatus.textContent = 'подключается';
    wsSent.textContent = sent;
    wsReceived.textContent = received;

    connection.addEventListener('open', () => {
      wsStatus.textContent = 'открыт';
      timer = setInterval(() => {
        if (connection.readyState !== WebSocket.OPEN || connection.bufferedAmount) return;
        connection.send(`${prefix}${++sent}`);
        wsSent.textContent = sent;
      }, 1000);
    });
    connection.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || !event.data.startsWith(prefix)) return;
      wsReceived.textContent = ++received;
    });
    connection.addEventListener('close', (event) => {
      clearInterval(timer);
      socket = undefined;
      wsStart.disabled = false;
      wsStop.disabled = true;
      wsStatus.textContent = `закрыт (${event.code})`;
    });
  });
  wsStop.addEventListener('click', () => socket?.close());
})();
