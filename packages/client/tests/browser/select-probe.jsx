import { useState } from 'react';
import { SingleSelect } from '../../src/workbench/SingleSelect.js';

// Geometry/keyboarding fixture: real public control, no RPC or application state.
export function SelectProbe() {
  const [value, setValue] = useState('first');
  return (
    <div className="zhuma" style={{ padding: 16 }}>
      <p>选择控件边界验证</p>
      <button>前一项</button>
      <div style={{ position: 'fixed', bottom: 12, right: 12, width: 200 }}>
        <SingleSelect
          label="边界选择"
          value={value}
          onValueChange={setValue}
          options={[
            { value: 'first', label: '第一项' },
            { value: 'disabled', label: '暂不可用', disabled: true },
            { value: 'last', label: '第三项 · 长中文名称用于验证菜单在窗口边缘自动避让和折行' },
          ]}
        />
        <button>后一项</button>
        <output aria-label="当前值">{value}</output>
      </div>
    </div>
  );
}
