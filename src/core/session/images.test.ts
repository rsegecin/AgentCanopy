import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BYTES_PER_MESSAGE,
  type AssistantMessage,
  type Attachment,
} from '../../shared';
import { sha256Hex } from '../util';
import { decodeBase64, matchesImageSignature } from './images';
import {
  createHarness,
  createPlanTestPolicy,
  finishedTurn,
  imageReference,
  pasteImageMessage,
  pngBytes,
  sendAndFinish,
  sleep,
  streamedText,
  resultStep,
  textScenario,
  until,
  type Harness,
  type ScenarioSpec,
  type TestView,
} from './test-support';
import { TEXT } from './text';

const harnesses: Harness[] = [];
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const answer = (text: string): ScenarioSpec => ({ scenario: textScenario(text) });

/** The bytes the controller holds for pasted images that are still in a draft. */
function heldImages(h: Harness): Map<string, Buffer> {
  const held: unknown = Reflect.get(h.controller, 'imageBytes');
  if (!(held instanceof Map)) throw new Error('the controller keeps no image bytes');
  return held as Map<string, Buffer>;
}

function draftOf(view: TestView): Attachment[] {
  return view.current().draftAttachments;
}

function userAttachments(view: TestView, index = 0): Attachment[] {
  const user = view.active().messages.filter((message) => message.role === 'user')[index];
  if (user?.role !== 'user') throw new Error('no user message');
  return user.attachments;
}

function noticesOf(message: AssistantMessage | undefined): string[] {
  return (message?.parts ?? []).flatMap((part) => (part.kind === 'notice' ? [part.text] : []));
}

function assistants(view: TestView): AssistantMessage[] {
  return view.active().messages.filter((m): m is AssistantMessage => m.role === 'assistant');
}

const A = pngBytes('image-a');
const B = pngBytes('image-b');

describe('decodeBase64', () => {
  it('decodes exact base64 and nothing else', () => {
    expect(decodeBase64('aGk=')?.toString()).toBe('hi');
    expect(decodeBase64('aGkh')?.toString()).toBe('hi!');
    expect(decodeBase64('aA==')?.toString()).toBe('h');
    for (const bad of ['', 'aGk', 'aG k=', 'aGk=aGk=', 'a===', 'a*k=', 'aGk=\n', '====']) {
      expect(decodeBase64(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('matchesImageSignature', () => {
  const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

  it('knows the first bytes of each type', () => {
    expect(matchesImageSignature('image/png', pngBytes())).toBe(true);
    expect(matchesImageSignature('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      true,
    );
    expect(matchesImageSignature('image/gif', Uint8Array.from(ascii('GIF87a....')))).toBe(true);
    expect(matchesImageSignature('image/gif', Uint8Array.from(ascii('GIF89a....')))).toBe(true);
    const webp = Uint8Array.from([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBPVP8 ')]);
    expect(matchesImageSignature('image/webp', webp)).toBe(true);
  });

  it('refuses another type, a short input and a RIFF file that is not WebP', () => {
    expect(matchesImageSignature('image/jpeg', pngBytes())).toBe(false);
    expect(matchesImageSignature('image/png', Uint8Array.from([0x89, 0x50]))).toBe(false);
    expect(matchesImageSignature('image/gif', Uint8Array.from(ascii('GIF90a')))).toBe(false);
    const wave = Uint8Array.from([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVEfmt ')]);
    expect(matchesImageSignature('image/webp', wave)).toBe(false);
    expect(matchesImageSignature('image/webp', Uint8Array.from(ascii('RIFF')))).toBe(false);
  });
});

describe('pasting an image', () => {
  it('attaches a reference with the hash, the type and the size, and keeps the bytes', async () => {
    const h = await harness({});
    const view = h.attach();
    view.send(pasteImageMessage(A));
    expect(draftOf(view)).toEqual([imageReference(A)]);
    expect(draftOf(view)[0]).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      bytes: A.length,
    });
    expect(heldImages(h).size).toBe(1);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('accepts each of the four types when the first bytes match', async () => {
    const h = await harness({});
    const view = h.attach();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    const gif = Buffer.from('GIF89a-gif');
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([1, 2, 3, 4]),
      Buffer.from('WEBPx'),
    ]);
    view.send(pasteImageMessage(A, 'image/png'));
    view.send(pasteImageMessage(jpeg, 'image/jpeg'));
    view.send(pasteImageMessage(gif, 'image/gif'));
    view.send(pasteImageMessage(webp, 'image/webp'));
    expect(draftOf(view)).toEqual([
      imageReference(A, 'image/png'),
      imageReference(jpeg, 'image/jpeg'),
      imageReference(gif, 'image/gif'),
      imageReference(webp, 'image/webp'),
    ]);
    expect(view.toasts).toEqual([]);
  });

  it('refuses text that is not base64, and attaches nothing', async () => {
    const h = await harness({});
    const view = h.attach();
    for (const data of ['not base64!', 'aGk', 'aGk=aGk=', 'aG k=', 'a===']) {
      view.send({ type: 'context.pasteImage', mediaType: 'image/png', data });
    }
    expect(draftOf(view)).toEqual([]);
    expect(heldImages(h).size).toBe(0);
    expect(view.toasts).toEqual(Array(5).fill({ level: 'warning', text: TEXT.imageInvalid }));
    expect(h.logger.has('warn', 'not valid base64')).toBe(true);
  });

  it('refuses bytes that are not of the declared type', async () => {
    const h = await harness({});
    const view = h.attach();
    view.send(pasteImageMessage(A, 'image/jpeg'));
    view.send(pasteImageMessage(Buffer.from('plain text, not an image'), 'image/png'));
    expect(draftOf(view)).toEqual([]);
    expect(heldImages(h).size).toBe(0);
    expect(view.toasts).toEqual([
      { level: 'warning', text: TEXT.imageInvalid },
      { level: 'warning', text: TEXT.imageInvalid },
    ]);
  });

  it('ignores an empty paste: the message is not valid, so nothing happens', async () => {
    const h = await harness({});
    const view = h.attach();
    view.send({ type: 'context.pasteImage', mediaType: 'image/png', data: '' });
    expect(draftOf(view)).toEqual([]);
    expect(view.toasts).toEqual([]);
    expect(h.logger.has('warn', 'invalid message')).toBe(true);
  });

  it('refuses an image over the size limit, and takes one of exactly the limit', async () => {
    const h = await harness({});
    const view = h.attach();
    view.send(pasteImageMessage(pngBytes('big', MAX_IMAGE_BYTES + 1)));
    expect(draftOf(view)).toEqual([]);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.imageTooLarge }]);

    const exact = pngBytes('exact', MAX_IMAGE_BYTES);
    view.send(pasteImageMessage(exact));
    expect(draftOf(view)).toEqual([imageReference(exact)]);
    expect(view.toasts).toHaveLength(1);
  });

  it('refuses the sixth image and keeps the first five', async () => {
    const h = await harness({});
    const view = h.attach();
    const images = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => pngBytes(`n${i}`));
    for (const bytes of images) view.send(pasteImageMessage(bytes));
    expect(draftOf(view)).toEqual(
      images.slice(0, MAX_IMAGES_PER_MESSAGE).map((b) => imageReference(b)),
    );
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.imageLimit }]);
    expect(heldImages(h).size).toBe(MAX_IMAGES_PER_MESSAGE);
  });

  it('refuses an image that would take the message over the combined size', async () => {
    const h = await harness({});
    const view = h.attach();
    const first = pngBytes('first', 3 * 1024 * 1024);
    const second = pngBytes('second', 3 * 1024 * 1024);
    view.send(pasteImageMessage(first));
    view.send(pasteImageMessage(second));
    expect(draftOf(view)).toEqual([imageReference(first)]);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.imagesTooLarge }]);
    expect(heldImages(h).size).toBe(1);
  });

  it('attaches the same bytes once, without a message', async () => {
    const h = await harness({});
    const view = h.attach();
    view.send(pasteImageMessage(A));
    view.send(pasteImageMessage(A));
    view.send(pasteImageMessage(B));
    view.send(pasteImageMessage(A));
    expect(draftOf(view)).toEqual([imageReference(A), imageReference(B)]);
    expect(view.toasts).toEqual([]);
    expect(heldImages(h).size).toBe(2);
  });

  it('the draft of each view is its own', async () => {
    const h = await harness({});
    const one = h.attach();
    const two = h.attach();
    one.send(pasteImageMessage(A));
    two.send(pasteImageMessage(B));
    expect(draftOf(one)).toEqual([imageReference(A)]);
    expect(draftOf(two)).toEqual([imageReference(B)]);
    one.send({ type: 'context.remove', attachment: imageReference(A) });
    // The bytes of the other view's image stay.
    expect([...heldImages(h).keys()]).toEqual([sha256Hex(B)]);
    one.expectMirror();
    two.expectMirror();
  });
});

describe('forgetting pasted images', () => {
  it('drops the bytes when the image is removed from the draft', async () => {
    const h = await harness({ sequence: [answer('ok')] });
    const view = h.attach();
    view.send(pasteImageMessage(A));
    view.send({ type: 'context.remove', attachment: imageReference(A) });
    expect(draftOf(view)).toEqual([]);
    expect(heldImages(h).size).toBe(0);

    await sendAndFinish(h, view, 'no picture');
    expect(h.requests[0]?.images).toBeUndefined();
    expect(userAttachments(view)).toEqual([]);
  });

  it('drops the bytes when the view starts another draft or is closed', async () => {
    const h = await harness({});
    const one = h.attach();
    const two = h.attach();
    one.send(pasteImageMessage(A));
    two.send(pasteImageMessage(B));
    expect(heldImages(h).size).toBe(2);

    // The view's draft is cleared; the bytes go with the next paste.
    one.send({ type: 'conversation.new' });
    expect(draftOf(one)).toEqual([]);
    one.send(pasteImageMessage(pngBytes('c')));
    expect(heldImages(h).size).toBe(2);

    two.dispose();
    expect(heldImages(h).size).toBe(1);
  });
});

describe('sending images', () => {
  it('sends the image in the message that follows the paste, even when nothing is awaited between them', async () => {
    const h = await harness({ sequence: [answer('seen')] });
    const view = h.attach();
    view.send(pasteImageMessage(A));
    view.send({ type: 'turn.send', text: 'what is this?', mode: 'ask', model: 'default' });
    await until('the conversation to be shown', () => view.state?.active !== null);
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');

    const request = h.requests[0];
    expect(request?.images).toHaveLength(1);
    expect(request?.images?.[0]?.mediaType).toBe('image/png');
    expect(Buffer.from(request?.images?.[0]?.data ?? []).equals(A)).toBe(true);
    expect(userAttachments(view)).toEqual([imageReference(A)]);
    expect(request?.prompt).toContain('Images attached to this message: 1');
    expect(request?.prompt).not.toContain('Referenced by the user:');
    expect(draftOf(view)).toEqual([]);
    expect(heldImages(h).size).toBe(0);
    view.expectMirror();
  });

  it('sends every image in order, with the files of the same message', async () => {
    const h = await harness({ sequence: [answer('seen')] });
    const view = h.attach();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7]);
    view.send(pasteImageMessage(B));
    h.ui.picked = ['a.ts'];
    view.send({ type: 'context.pick', what: 'file' });
    await until('the file', () => draftOf(view).length === 2);
    view.send(pasteImageMessage(jpeg, 'image/jpeg'));
    await sendAndFinish(h, view, 'compare');

    const images = h.requests[0]?.images ?? [];
    expect(images.map((image) => image.mediaType)).toEqual(['image/png', 'image/jpeg']);
    expect(Buffer.from(images[0]?.data ?? []).equals(B)).toBe(true);
    expect(Buffer.from(images[1]?.data ?? []).equals(jpeg)).toBe(true);
    expect(userAttachments(view)).toEqual([
      imageReference(B),
      { kind: 'file', path: 'a.ts' },
      imageReference(jpeg, 'image/jpeg'),
    ]);
    expect(h.requests[0]?.prompt).toContain('Referenced by the user:\n- a.ts');
  });

  it('has no images key at all on the request of a text-only turn, before and after an image turn', async () => {
    const h = await harness({ sequence: [answer('one'), answer('two'), answer('three')] });
    const view = h.attach();
    await sendAndFinish(h, view, 'text only');
    view.send(pasteImageMessage(A));
    await sendAndFinish(h, view, 'with an image');
    await sendAndFinish(h, view, 'text again');

    expect(h.requests).toHaveLength(3);
    expect('images' in (h.requests[0] ?? {})).toBe(false);
    expect('images' in (h.requests[1] ?? {})).toBe(true);
    expect('images' in (h.requests[2] ?? {})).toBe(false);
    expect(h.requests[0]?.prompt).not.toContain('Images attached');
    expect(h.requests[2]?.prompt).not.toContain('Images attached');
  });

  it('leaves out an image whose bytes are gone, and says so', async () => {
    const h = await harness({ sequence: [answer('ok')] });
    const view = h.attach();
    view.send(pasteImageMessage(A));
    view.send(pasteImageMessage(B));
    heldImages(h).delete(sha256Hex(A));

    await sendAndFinish(h, view, 'go');
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.imageGone }]);
    expect(h.logger.has('warn', 'no longer available')).toBe(true);
    expect(h.requests[0]?.images).toHaveLength(1);
    expect(Buffer.from(h.requests[0]?.images?.[0]?.data ?? []).equals(B)).toBe(true);
    expect(userAttachments(view)).toEqual([imageReference(B)]);
    expect(draftOf(view)).toEqual([]);
  });

  it('never writes the image data to the log', async () => {
    const h = await harness({ sequence: [answer('ok')] });
    const view = h.attach();
    view.send(pasteImageMessage(A));
    view.send({ type: 'context.pasteImage', mediaType: 'image/png', data: 'bad data!' });
    await sendAndFinish(h, view, 'go');
    const everything = JSON.stringify(h.logger.entries);
    expect(everything).not.toContain(A.toString('base64'));
    expect(everything).not.toContain('bad data!');
  });
});

describe('an image turn that loses its session', () => {
  const missing = {
    steps: [
      {
        emit: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['No conversation found with session ID: gone'],
          session_id: '$SESSION',
        },
      },
      { exit: 1 },
    ],
  };

  it('sends the same images again in the new session', async () => {
    const h = await harness({
      sequence: [answer('first'), { scenario: missing }, answer('second')],
    });
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    view.send(pasteImageMessage(A));
    const turn = await sendAndFinish(h, view, 'two');
    expect(turn.status).toBe('completed');

    expect(h.requests).toHaveLength(3);
    expect(h.requests[1]?.session.kind).toBe('resume');
    expect(h.requests[2]?.session.kind).toBe('new');
    for (const request of h.requests.slice(1)) {
      expect(request.images).toHaveLength(1);
      expect(Buffer.from(request.images?.[0]?.data ?? []).equals(A)).toBe(true);
    }
    expect('images' in (h.requests[0] ?? {})).toBe(false);
    // The image of this message is not an earlier one: nothing is said about lost images.
    expect(noticesOf(assistants(view)[1])).toEqual([TEXT.sessionLost]);
  });

  it('tells the user that earlier images were not carried into the new session', async () => {
    const h = await harness({
      sequence: [answer('first'), { scenario: missing }, answer('second')],
    });
    const view = h.attach();
    view.send(pasteImageMessage(A));
    await sendAndFinish(h, view, 'look at this');
    await sendAndFinish(h, view, 'and now?');

    expect(h.requests[2]?.session.kind).toBe('new');
    // The earlier message is named in the transcript, its bytes are not sent again.
    expect(h.requests[2]?.prompt.startsWith('<prior-conversation reconstructed="true">')).toBe(
      true,
    );
    expect(h.requests[2]?.prompt).toContain('Attached: image (png)');
    expect('images' in (h.requests[2] ?? {})).toBe(false);
    expect(noticesOf(assistants(view)[1])).toEqual([TEXT.sessionLost, TEXT.earlierImagesLost]);
  });

  it('says nothing about images when no earlier message had one', async () => {
    const h = await harness({
      sequence: [answer('first'), { scenario: missing }, answer('second')],
    });
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    await sendAndFinish(h, view, 'two');
    expect(noticesOf(assistants(view)[1])).toEqual([TEXT.sessionLost]);
  });
});

describe('a view that is slow to send', () => {
  it('keeps the bytes of a draft while another view sends and pastes', async () => {
    const h = await harness({ sequence: [answer('ok')] });
    const one = h.attach();
    const two = h.attach();
    one.send(pasteImageMessage(A));
    two.send(pasteImageMessage(B));
    await sendAndFinish(h, two, 'from two');
    await sleep(10);
    expect(heldImages(h).size).toBe(1);
    expect(draftOf(one)).toEqual([imageReference(A)]);
    expect(h.requests[0]?.images).toHaveLength(1);
    expect(Buffer.from(h.requests[0]?.images?.[0]?.data ?? []).equals(B)).toBe(true);
  });
});

describe('an image in a message queued behind a running turn', () => {
  it('is held after pruning and is sent with the dispatched turn', async () => {
    const h = await harness({
      policy: createPlanTestPolicy(),
      sequence: [
        {
          scenario: {
            steps: [...streamedText(['working']), { sleep: 500 }, ...resultStep('first')],
          },
        },
        answer('seen'),
      ],
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'first', mode: 'agent', model: 'default' });
    await until('the first turn to run', () => h.requests.length === 1);
    await until('the conversation to be shown', () => view.state?.active != null);

    view.send(pasteImageMessage(A));
    view.send({
      type: 'turn.send',
      conversationId: view.active().meta.id,
      text: 'what is this?',
      mode: 'agent',
      model: 'default',
    });
    await until('the message to be queued', () => view.state?.active?.queued != null);
    expect(view.active().queued?.attachments).toEqual([imageReference(A)]);
    expect(draftOf(view)).toEqual([]);

    // Something that prunes: another view comes and goes. The bytes stay, the queued message needs them.
    h.attach().dispose();
    expect(heldImages(h).size).toBe(1);

    await until('the second turn', () => h.requests.length === 2);
    await until('the queue to empty', () => view.state?.active?.queued === null);
    await finishedTurn(h, view);
    const request = h.requests[1];
    expect(request?.images).toHaveLength(1);
    expect(Buffer.from(request?.images?.[0]?.data ?? []).equals(A)).toBe(true);
    expect(userAttachments(view, 1)).toEqual([imageReference(A)]);
    expect(heldImages(h).size).toBe(0);
    view.expectMirror();
  });

  it('is released when the queued message is removed', async () => {
    const h = await harness({
      policy: createPlanTestPolicy(),
      sequence: [
        { scenario: { steps: [...streamedText(['working']), { hang: true }] } },
        answer('seen'),
      ],
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'first', mode: 'agent', model: 'default' });
    await until('the first turn to run', () => h.requests.length === 1);
    await until('the conversation to be shown', () => view.state?.active != null);
    const id = view.active().meta.id;
    view.send(pasteImageMessage(A));
    view.send({
      type: 'turn.send',
      conversationId: id,
      text: 'two',
      mode: 'agent',
      model: 'default',
    });
    await until('the message to be queued', () => view.state?.active?.queued != null);
    expect(heldImages(h).size).toBe(1);

    // Taking it back for editing returns the image to the draft, still held.
    view.send({ type: 'queue.edit', conversationId: id });
    expect(draftOf(view)).toEqual([imageReference(A)]);
    expect(heldImages(h).size).toBe(1);
    view.send({
      type: 'turn.send',
      conversationId: id,
      text: 'two again',
      mode: 'agent',
      model: 'default',
    });
    await until('the message to be queued again', () => view.state?.active?.queued != null);
    view.send({ type: 'queue.remove', conversationId: id });
    expect(heldImages(h).size).toBe(0);
    view.send({ type: 'turn.cancel', conversationId: id });
    await finishedTurn(h, view);
  });

  /** A running turn, a message with image `queued` waiting behind it, and then `draft` pasted into the draft. */
  async function queuedWithFullDraft(queued: Buffer, draft: Buffer[]) {
    const h = await harness({
      policy: createPlanTestPolicy(),
      sequence: [
        { scenario: { steps: [...streamedText(['working']), { hang: true }] } },
        answer('seen'),
      ],
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'first', mode: 'agent', model: 'default' });
    await until('the first turn to run', () => h.requests.length === 1);
    await until('the conversation to be shown', () => view.state?.active != null);
    const id = view.active().meta.id;
    view.send(pasteImageMessage(queued));
    view.send({
      type: 'turn.send',
      conversationId: id,
      text: 'two',
      mode: 'agent',
      model: 'default',
    });
    await until('the message to be queued', () => view.state?.active?.queued != null);
    for (const bytes of draft) view.send(pasteImageMessage(bytes));
    return { h, view, id };
  }

  it('is not put back into a draft that already holds the most images, and its bytes are released', async () => {
    const draft = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, i) => pngBytes(`full${i}`));
    const { h, view, id } = await queuedWithFullDraft(A, draft);
    expect(draftOf(view)).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(heldImages(h).size).toBe(MAX_IMAGES_PER_MESSAGE + 1);

    view.send({ type: 'queue.edit', conversationId: id });
    expect(view.active().queued).toBeNull();
    expect(draftOf(view)).toEqual(draft.map((bytes) => imageReference(bytes)));
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.imageLimit }]);
    expect(heldImages(h).size).toBe(MAX_IMAGES_PER_MESSAGE);
    expect(heldImages(h).has(sha256Hex(A))).toBe(false);
    expect(view.events.filter((event) => event.kind === 'prefill-composer')).toEqual([
      { kind: 'prefill-composer', text: 'two' },
    ]);
    view.send({ type: 'turn.cancel', conversationId: id });
    await finishedTurn(h, view);
  });

  it('is not put back into a draft that would pass the combined size, and its bytes are released', async () => {
    const big = pngBytes('big', MAX_IMAGE_BYTES_PER_MESSAGE - 1024);
    const { h, view, id } = await queuedWithFullDraft(pngBytes('second', 2048), [big]);
    expect(draftOf(view)).toEqual([imageReference(big)]);

    view.send({ type: 'queue.edit', conversationId: id });
    expect(draftOf(view)).toEqual([imageReference(big)]);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.imagesTooLarge }]);
    expect(heldImages(h).size).toBe(1);
    view.send({ type: 'turn.cancel', conversationId: id });
    await finishedTurn(h, view);
  });
});
