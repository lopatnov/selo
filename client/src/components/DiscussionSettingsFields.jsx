import { readDiscussionSettings } from '../discussionSettings';

/**
 * The four discussion controls every AI personality owns:
 *  - send immediately (checkbox);
 *  - a min/max delay range in seconds used when the checkbox is off;
 *  - the maximum number of messages on one news item;
 *  - the maximum number of its own messages in a row.
 *
 * The component is controlled: it only reports the next complete settings
 * object, so both the add form and the inline editor share it.
 */
function DiscussionSettingsFields({ settings, onChange, idPrefix = 'discussion' }) {
  const values = readDiscussionSettings(settings);

  const update = field => event => {
    const target = event.target;
    const value = target.type === 'checkbox' ? target.checked : target.value;
    onChange({ ...values, [field]: value });
  };

  return (
    <fieldset className="discussion-settings">
      <legend>Discussion behaviour</legend>

      <label className="discussion-checkbox" htmlFor={`${idPrefix}-send-immediately`}>
        <input
          id={`${idPrefix}-send-immediately`}
          type="checkbox"
          checked={values.sendImmediately}
          onChange={update('sendImmediately')}
        />
        <span>Send messages immediately</span>
      </label>

      {values.sendImmediately ? (
        <small className="provider-hint">
          No delay: the message is posted the moment the model answers. Clear the checkbox to pace
          the personality instead.
        </small>
      ) : (
        <>
          <small className="provider-hint">
            Each message waits a random time between these two values.
          </small>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor={`${idPrefix}-delay-min`}>Min delay between messages (s)</label>
              <input
                id={`${idPrefix}-delay-min`}
                type="number"
                min="0"
                max="3600"
                step="1"
                value={values.delayMinSec}
                onChange={update('delayMinSec')}
              />
            </div>
            <div className="form-group">
              <label htmlFor={`${idPrefix}-delay-max`}>Max delay between messages (s)</label>
              <input
                id={`${idPrefix}-delay-max`}
                type="number"
                min="0"
                max="3600"
                step="1"
                value={values.delayMaxSec}
                onChange={update('delayMaxSec')}
              />
            </div>
          </div>
        </>
      )}

      <div className="form-row">
        <div className="form-group">
          <label htmlFor={`${idPrefix}-max-per-news`}>Max messages per news</label>
          <input
            id={`${idPrefix}-max-per-news`}
            type="number"
            min="1"
            max="500"
            step="1"
            value={values.maxMessagesPerNews}
            onChange={update('maxMessagesPerNews')}
          />
        </div>
        <div className="form-group">
          <label htmlFor={`${idPrefix}-max-consecutive`}>Max own messages in a row</label>
          <input
            id={`${idPrefix}-max-consecutive`}
            type="number"
            min="1"
            max="50"
            step="1"
            value={values.maxConsecutiveMessages}
            onChange={update('maxConsecutiveMessages')}
          />
        </div>
      </div>

      <small className="provider-hint">
        The discussion loop stops this AI at {values.maxMessagesPerNews} message(s) on one news
        item, and it steps aside after {values.maxConsecutiveMessages} own message(s) in a row so
        another participant can speak.
      </small>
    </fieldset>
  );
}

export default DiscussionSettingsFields;
