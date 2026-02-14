export type DebugEvent = {
  ts: number;          // epoch ms
  type: string;        // evt.type or local label
  summary?: string;    // small readable info
  raw?: any;           // optional raw object (keep off by default if you want)
};

export type VadSettings = {
  threshold: number;         // 0..1
  prefixPaddingMs: number;   // e.g. 0..2000
  silenceDurationMs: number; // e.g. 200..5000
};

export type RtState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'responding'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { environment } from './environment';

export type ChatMsg = {
  role: 'user' | 'assistant';
  text: string;
  ts: number; // epoch ms
};

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private localStream?: MediaStream;

  private messagesSubject = new BehaviorSubject<ChatMsg[]>([]);
  messages$ = this.messagesSubject.asObservable();

  private userDraft = '';
  private assistantDraft = '';
  private assistantInProgress = false;
  private lastDeviceId?: string;
  private lastVad?: VadSettings;
  private lastSystemPrompt?: string;
  private lastApiKey?: string;
  private reconnecting = false;
  private debugEnabled = true;
  private debugSubject = new BehaviorSubject<DebugEvent[]>([]);
  debug$ = this.debugSubject.asObservable();

  private stateSubject = new BehaviorSubject<RtState>('idle');
  state$ = this.stateSubject.asObservable();

  private readonly FETCH_TIMEOUT_MS = 15_000;

  private setState(s: RtState, note?: string) {
    this.stateSubject.next(s);
    this.pushDebug?.('state', `${s}${note ? ' | ' + note : ''}`);
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const resp = await this.fetchWithTimeout(`${environment.apiBase}/api/validate-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    return resp.json();
  }

  async connect(deviceId?: string, vad?: VadSettings, systemPrompt?: string, apiKey?: string) {
    this.setState('connecting');
    this.lastDeviceId = deviceId;
    this.lastVad = vad;
    this.lastSystemPrompt = systemPrompt;
    this.lastApiKey = apiKey;
    this.pushDebug('client.connect', `deviceId=${deviceId || 'default'}`);

    // 1) Get ephemeral client secret from Spring Boot
    const tokenBody: Record<string, unknown> = {};
    if (vad) {
      tokenBody['threshold'] = vad.threshold;
      tokenBody['prefixPaddingMs'] = vad.prefixPaddingMs;
      tokenBody['silenceDurationMs'] = vad.silenceDurationMs;
    }
    if (apiKey?.trim()) {
      tokenBody['apiKey'] = apiKey.trim();
    }

    const tokenResp = await this.fetchWithTimeout(`${environment.apiBase}/api/realtime-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenBody)
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `Server error ${tokenResp.status}`);
    }

    const session = await tokenResp.json();
    this.pushDebug('token.ok');

    const clientSecret: string | undefined = session?.client_secret?.value;
    if (!clientSecret) throw new Error('No client_secret returned from backend');

    // 2) Capture audio
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    });
    const tracks = this.localStream.getAudioTracks();
    this.pushDebug('audio.ok', `tracks=${tracks.length} label=${tracks[0]?.label || ''}`);

    // 3) WebRTC setup
    this.pc = new RTCPeerConnection();

    this.pc.oniceconnectionstatechange = () => {
      this.pushDebug('pc.ice', `${this.pc?.iceConnectionState}`);
      const st = this.pc?.iceConnectionState;
      console.log('ICE state:', st);

      if (st === 'connected' || st === 'completed') this.setState('listening');
      if (st === 'disconnected' || st === 'failed') this.setState('reconnecting');
      if (st === 'closed') this.setState('disconnected');

      if (st === 'failed' || st === 'disconnected') {
        this.tryReconnect();
      }
    };

    this.pc.onconnectionstatechange = () => {
      this.pushDebug('pc.state', `${this.pc?.connectionState}`);
      const st = this.pc?.connectionState;
      console.log('PC state:', st);

      if (st === 'connected') this.setState('listening');
      if (st === 'disconnected') this.setState('reconnecting');
      if (st === 'failed') this.setState('reconnecting');
      if (st === 'closed') this.setState('disconnected');

      if (st === 'failed' || st === 'disconnected') {
        this.tryReconnect();
      }
    };

    for (const track of this.localStream.getTracks()) {
      this.pc.addTrack(track, this.localStream);
    }

    // Data channel for events
    this.dc = this.pc.createDataChannel('oai-events');
    this.dc.onmessage = (ev) => this.onServerEvent(ev.data);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    // 4) Send SDP to OpenAI Realtime, get SDP answer
    const sdpResp = await fetch(
      'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp
      }
    );

    if (!sdpResp.ok) {
      throw new Error(`Realtime SDP error: ${sdpResp.status} ${await sdpResp.text()}`);
    }

    const answerSdp = await sdpResp.text();
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await this.waitForDataChannelOpen();

    // Optional: override instructions
    this.sendEvent({
      type: 'session.update',
      session: { instructions: systemPrompt || 'You are a helpful assistant.' }
    });

    this.setState('listening');
  }

  disconnect({ clearMessages = false }: { clearMessages?: boolean } = {}) {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.dc = undefined;
    this.pc = undefined;

    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = undefined;
    }

    this.userDraft = '';
    this.assistantDraft = '';
    this.assistantInProgress = false;

    if (clearMessages) {
      this.messagesSubject.next([]);
    }

    this.pushDebug('client.disconnect', `clearMessages=${clearMessages}`);
  }

  private sendEvent(evt: any) {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.dc.send(JSON.stringify(evt));
  }

  private upsertDraft(role: ChatMsg['role'], text: string) {
    const list = this.messagesSubject.value.slice();
    const last = list[list.length - 1];

    if (last && last.role === role && last.text.startsWith('[draft]')) {
      list[list.length - 1] = { ...last, text: `[draft]${text}` };
    } else {
      list.push({ role, text: `[draft]${text}`, ts: Date.now() });
    }

    this.messagesSubject.next(list);
  }

  private finalizeDraft(role: ChatMsg['role'], finalText: string) {
    const list = this.messagesSubject.value.slice();
    const last = list[list.length - 1];

    if (last && last.role === role && last.text.startsWith('[draft]')) {
      list[list.length - 1] = { ...last, text: finalText };
    } else {
      list.push({ role, text: finalText, ts: Date.now() });
    }

    this.messagesSubject.next(list);
  }

  private onServerEvent(raw: string) {
    let evt: any;
    try { evt = JSON.parse(raw); } catch { return; }

    switch (evt.type) {
      case 'input_audio_buffer.speech_started':
        this.pushDebug(evt.type);
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this.pushDebug(evt.type, `+${(evt.delta || '').length} chars`);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.pushDebug(evt.type, `${(evt.transcript || '').length} chars`);
        break;

      case 'response.text.delta':
        this.pushDebug(evt.type, `+${(evt.delta || '').length} chars`);
        break;

      case 'response.text.done':
        this.pushDebug(evt.type, `${this.assistantDraft.length} chars`);
        break;

      case 'error':
        this.pushDebug('error', evt.error?.message || 'unknown', evt.error);
        break;

      default:
        break;
    }

    if (evt.type === 'input_audio_buffer.speech_started') {
      this.setState('listening');
      this.userDraft = '';
      this.upsertDraft('user', '');

      if (this.assistantInProgress) {
        this.markAssistantInterrupted();
        this.sendEvent({ type: 'response.cancel' });
        this.assistantInProgress = false;
        this.assistantDraft = '';
      }
      return;
    }

    if (evt.type === 'conversation.item.input_audio_transcription.delta') {
      this.userDraft += (evt.delta || '');
      this.upsertDraft('user', this.userDraft);
      return;
    }

    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      this.setState('thinking');
      const finalUserText = (evt.transcript || this.userDraft || '').trim();
      this.finalizeDraft('user', finalUserText);

      this.userDraft = '';
      this.assistantDraft = '';

      this.assistantInProgress = true;
      this.sendEvent({ type: 'response.create', response: { modalities: ['text'] } });
      return;
    }

    if (evt.type === 'response.text.delta') {
      if (this.stateSubject.value !== 'responding') {
        this.setState('responding');
      }
      if (!this.assistantInProgress) return;
      this.assistantDraft += (evt.delta || '');
      this.upsertDraft('assistant', this.assistantDraft);
      return;
    }

    if (evt.type === 'response.text.done') {
      this.finalizeDraft('assistant', this.assistantDraft);
      this.assistantInProgress = false;
      this.setState('listening');
      return;
    }

    if (evt.type === 'error') {
      this.assistantInProgress = false;
      this.setState('error');
      const msg = evt.error?.message || JSON.stringify(evt.error || evt);
      this.messagesSubject.next([
        ...this.messagesSubject.value,
        { role: 'assistant', text: `Realtime error: ${msg}`, ts: Date.now() }
      ]);
      return;
    }

  }

  private async waitForDataChannelOpen(): Promise<void> {
    if (!this.dc) throw new Error('DataChannel not created');

    if (this.dc.readyState === 'open') return;

    await new Promise<void>((resolve, reject) => {
      const dc = this.dc!;
      const timeout = setTimeout(() => reject(new Error('DataChannel open timeout')), 8000);

      dc.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      dc.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('DataChannel error'));
      };
    });
  }

  private markAssistantInterrupted() {
    const list = this.messagesSubject.value.slice();
    const last = list[list.length - 1];

    if (last?.role === 'assistant' && last.text.startsWith('[draft]')) {
      const text = last.text.replace(/^\[draft\]/, '').trim();
      list[list.length - 1] = { role: 'assistant', text: text ? `${text} (interrupted)` : '(interrupted)', ts: Date.now() };
      this.messagesSubject.next(list);
    }
  }

  private async tryReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.setState('reconnecting');

    this.messagesSubject.next([
      ...this.messagesSubject.value,
      { role: 'assistant', text: 'Connection lost... reconnecting.', ts: Date.now() }
    ]);

    const delays = [250, 500, 1000, 2000, 4000];

    for (const ms of delays) {
      try {
        this.disconnect({ clearMessages: false });

        await new Promise(r => setTimeout(r, ms));
        await this.connect(this.lastDeviceId, this.lastVad, this.lastSystemPrompt, this.lastApiKey);

        this.messagesSubject.next([
          ...this.messagesSubject.value,
          { role: 'assistant', text: 'Reconnected.', ts: Date.now() }
        ]);

        this.reconnecting = false;
        return;
      } catch (e) {
        console.warn('Reconnect attempt failed:', e);
      }
    }

    this.messagesSubject.next([
      ...this.messagesSubject.value,
      { role: 'assistant', text: 'Could not reconnect. Please click Start again.', ts: Date.now() }
    ]);

    this.setState('disconnected');
    this.reconnecting = false;
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw e;
    } finally {
      clearTimeout(id);
    }
  }

  private pushDebug(type: string, summary?: string, raw?: any) {
    if (!this.debugEnabled) return;

    const list = this.debugSubject.value.slice();
    list.push({ ts: Date.now(), type, summary, raw });

    const trimmed = list.length > 200 ? list.slice(list.length - 200) : list;
    this.debugSubject.next(trimmed);
  }

  clearDebug() {
    this.debugSubject.next([]);
  }

  setDebugEnabled(enabled: boolean) {
    this.debugEnabled = enabled;
  }

  getMessages(): ChatMsg[] {
    return this.messagesSubject.value.slice();
  }

}
