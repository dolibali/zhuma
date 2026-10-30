import { useEffect, useState } from 'react';
import type { MemberAssetReadValue } from '@zhuma/agent-core';
import type { MemberAssetFileContent } from './api.js';
import { Modal } from '../workbench/controls.js';
import { Button } from '../workbench/Button.js';

export function MemberAssetFilePreview({
  value,
  close,
  title,
}: {
  value: { file: NonNullable<MemberAssetReadValue['file']>; content: MemberAssetFileContent };
  close(): void;
  title?: string;
}) {
  const [url, setUrl] = useState(''),
    [text, setText] = useState('');
  useEffect(() => {
    const href = URL.createObjectURL(value.content.blob);
    setUrl(href);
    let active = true;
    if (value.content.contentType.startsWith('text/plain'))
      void value.content.blob.text().then((body) => {
        if (active) setText(body.slice(0, 65536));
      });
    return () => {
      active = false;
      URL.revokeObjectURL(href);
    };
  }, [value]);
  const type = value.content.contentType;
  return (
    <Modal title={title ?? value.file.name} close={close}>
      <div className="zm-form zm-member-asset-preview">
        {!value.content.inline ? (
          <p>此格式请下载后查看。</p>
        ) : type.startsWith('text/plain') ? (
          <>
            <pre className="zm-member-asset-text">{text}</pre>
            {value.file.byteSize > 65536 && <p>预览显示前 64 KB，下载可查看完整内容。</p>}
          </>
        ) : type.startsWith('image/') ? (
          <img src={url} alt={value.file.name} />
        ) : type === 'application/pdf' ? (
          <iframe title={value.file.name} src={url} sandbox="" referrerPolicy="no-referrer" />
        ) : (
          <p>此格式请下载后查看。</p>
        )}
        <footer>
          <a className="zm-button secondary" href={url} download={value.file.name}>
            下载文件
          </a>
          <Button onClick={close}>关闭</Button>
        </footer>
      </div>
    </Modal>
  );
}
