import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { SYSTEM_PROMPT } from './prompt';

export type ChatMsg = { role: 'user' | 'assistant'; text: string };

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

  async connect(deviceId?: string) {
    // 1) Get ephemeral client secret from Spring Boot
    const session = await fetch('http://localhost:8080/api/realtime-token').then(r => r.json());
    const clientSecret: string | undefined = session?.client_secret?.value;
    if (!clientSecret) throw new Error('No client_secret returned from backend');

    // 2) Capture audio
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    });

    // 3) WebRTC setup
    this.pc = new RTCPeerConnection();

    this.pc.oniceconnectionstatechange = () =>
      console.log('ICE state:', this.pc?.iceConnectionState);

    this.pc.onconnectionstatechange = () =>
      console.log('PC state:', this.pc?.connectionState);

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
      session: { instructions: SYSTEM_PROMPT }
    });
  }

  disconnect() {
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
    this.messagesSubject.next([]);
  }

  private sendEvent(evt: any) {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.dc.send(JSON.stringify(evt));
  }

  private upsertDraft(role: ChatMsg['role'], text: string) {
    const list = this.messagesSubject.value.slice();
    const last = list[list.length - 1];

    if (last && last.role === role && last.text.startsWith('[draft]')) {
      list[list.length - 1] = { role, text: `[draft]${text}` };
    } else {
      list.push({ role, text: `[draft]${text}` });
    }

    this.messagesSubject.next(list);
  }

  private finalizeDraft(role: ChatMsg['role'], finalText: string) {
    const list = this.messagesSubject.value.slice();

    // remove any trailing draft of same role
    const last = list[list.length - 1];
    if (last && last.role === role && last.text.startsWith('[draft]')) {
      list[list.length - 1] = { role, text: finalText };
    } else {
      list.push({ role, text: finalText });
    }

    this.messagesSubject.next(list);
  }

  private upsert(role: ChatMsg['role'], text: string) {
    const list = this.messagesSubject.value.slice();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === role) {
        list[i] = { role, text };
        this.messagesSubject.next(list);
        return;
      }
    }
    list.push({ role, text });
    this.messagesSubject.next(list);
  }

  private onServerEvent(raw: string) {
    let evt: any;
    try { evt = JSON.parse(raw); } catch { return; }

    // ✅ NEW: Reset draft at the start of a new speech segment
    // (This event is emitted when server VAD detects speech.)
    if (evt.type === 'input_audio_buffer.speech_started') {
      // reset user draft for the new turn (from #1)
      this.userDraft = '';
      this.upsertDraft('user', '');

      // ✅ BARGE-IN: cancel assistant if it's responding
      if (this.assistantInProgress) {
        // optional UI polish:
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
      const finalUserText = (evt.transcript || this.userDraft || '').trim();
      this.finalizeDraft('user', finalUserText);

      this.userDraft = '';
      this.assistantDraft = '';

      this.assistantInProgress = true; // ✅
      this.sendEvent({ type: 'response.create', response: { modalities: ['text'] } });
      return;
    }

    if (evt.type === 'response.text.delta') {
      if (!this.assistantInProgress) return; // ✅ ignore late deltas
      this.assistantDraft += (evt.delta || '');
      this.upsertDraft('assistant', this.assistantDraft);
      return;
    }

    if (evt.type === 'response.text.done') {
      this.finalizeDraft('assistant', this.assistantDraft);
      this.assistantInProgress = false; // ✅
      return;
    }

    if (evt.type === 'error') {
      this.assistantInProgress = false;
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
    // If last assistant message is a draft, finalize it with a note (optional)
    const list = this.messagesSubject.value.slice();
    const last = list[list.length - 1];

    if (last?.role === 'assistant' && last.text.startsWith('[draft]')) {
      const text = last.text.replace(/^\[draft\]/, '').trim();
      list[list.length - 1] = { role: 'assistant', text: text ? `${text} (interrupted)` : '(interrupted)' };
      this.messagesSubject.next(list);
    }
  }

}
