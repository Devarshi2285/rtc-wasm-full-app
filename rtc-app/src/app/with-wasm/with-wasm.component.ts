import { Component, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';

// Side-effect import — registers window.mediasoupBridge before WASM boots
import '../mediasoup-bridge';
@Component({
  selector: 'app-with-wasm',
  imports: [CommonModule],
  templateUrl: './with-wasm.component.html',
  styles: [`
    :host {
      display: block;
      padding: 20px;
      font-family: sans-serif;
    }
    .video-grid {
      display: flex;
      gap: 20px;
      margin-top: 20px;
    }
    video {
      width: 320px;
      height: 240px;
      background: #000;
      border-radius: 4px;
    }
  `]
})
export class WithWasmComponent {

  private wasm: any;

  callStarted = false;
  isConnected = false;
  remoteVideoStreams: any[] = [];
  remoteAudioStreams: any[] = [];

  constructor(private ngZone: NgZone) { }

  async ngOnInit(): Promise<void> {
    // ── Register callbacks that WASM / bridge will invoke ──
    (window as any).__rtcCallbacks = {

      onConnectionChange: (connected: boolean) => {
        this.ngZone.run(() => {
          this.isConnected = connected;
        });
      },

      onLocalStream: (stream: MediaStream) => {
        this.ngZone.run(() => {
          const el = document.getElementById('localVideo') as HTMLVideoElement;
          if (el) el.srcObject = stream;
        });
      },

      onRemoteStream: (stream: MediaStream, kind: string, producerId: string) => {
        this.ngZone.run(() => {
          if (kind === 'video') {
            this.remoteVideoStreams.push({ id: producerId, stream });
          } else if (kind === 'audio') {
            this.remoteAudioStreams.push({ id: producerId, stream });
          }
        });
      },
    };

    // ── Load WASM module and connect ──
    try {
      this.wasm = await import('rtc-wasm');
      await this.wasm.default('/rtc_wasm_bg.wasm');   // load .wasm from public/
      this.wasm.connect('ws://localhost:3000');
    } catch (err) {
      console.error('Failed to load WASM module:', err);
    }
  }

  start() {
    this.callStarted = true;
    this.wasm?.start_call();
  }

}
