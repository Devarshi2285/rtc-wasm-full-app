import { ComponentFixture, TestBed } from '@angular/core/testing';

import { WithWasmComponent } from './with-wasm.component';

describe('WithWasmComponent', () => {
  let component: WithWasmComponent;
  let fixture: ComponentFixture<WithWasmComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WithWasmComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(WithWasmComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
