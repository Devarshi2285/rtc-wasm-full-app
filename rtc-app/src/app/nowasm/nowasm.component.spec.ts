import { ComponentFixture, TestBed } from '@angular/core/testing';

import { NowasmComponent } from './nowasm.component';

describe('NowasmComponent', () => {
  let component: NowasmComponent;
  let fixture: ComponentFixture<NowasmComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NowasmComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(NowasmComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
