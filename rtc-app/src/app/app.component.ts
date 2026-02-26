import { Component, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';

// Side-effect import — registers window.mediasoupBridge before WASM boots
import './mediasoup-bridge';
import { WithWasmComponent } from './with-wasm/with-wasm.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, WithWasmComponent],
  templateUrl: './app.component.html',
})
export class App {

}