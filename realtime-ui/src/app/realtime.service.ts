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

    // USER transcript streaming
    if (evt.type === 'conversation.item.input_audio_transcription.delta') {
      this.userDraft += (evt.delta || '');
      this.upsert('user', this.userDraft);
      return;
    }

    // USER transcript final -> trigger assistant response
    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      this.userDraft = evt.transcript || this.userDraft;
      this.upsert('user', this.userDraft);

      this.assistantDraft = '';
      this.sendEvent({ type: 'response.create', response: { modalities: ['text'] } });
      return;
    }

    // ASSISTANT text streaming
    if (evt.type === 'response.text.delta') {
      this.assistantDraft += (evt.delta || '');
      this.upsert('assistant', this.assistantDraft);
      return;
    }

    // Helpful if event names differ:
    // console.log('evt', evt);
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


}
