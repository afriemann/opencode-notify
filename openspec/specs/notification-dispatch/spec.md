# notification-dispatch Specification

## Purpose
Sends desktop and webhook notifications for opencode session lifecycle events (permission requests, task completion, todo completion, session failure, and requests for user input), so a user working in another window or application is alerted when their attention is needed, and dismisses notifications automatically once the user has responded.

## Requirements

### Requirement: Session Title Tracking
The system SHALL maintain a per-session human-readable title for use in notification text, taken from the most recently observed session title event or, when none is known, looked up once from the host, and SHALL discard a session's state when that session is deleted.

#### Scenario: Title is cached when a session is created or renamed
- **WHEN** a session-created or session-renamed event carries a non-empty title
- **THEN** that title is recorded for the session's ID and used in any subsequent notification for that session

#### Scenario: Falls back to a truncated session ID when no title is known
- **WHEN** a notification is composed for a session whose title has never been recorded and the host cannot supply one
- **THEN** the notification uses a fallback label derived from the first eight characters of the session ID

#### Scenario: Title is looked up when no title event was observed
- **WHEN** a notification is composed for a session whose title has never been recorded and the host can supply it
- **THEN** the notification uses the title supplied by the host, and later notifications for that session reuse it without another lookup

#### Scenario: A failed lookup is not retried for every event
- **WHEN** the title lookup for a session fails
- **THEN** the fallback label is used and no further lookup is made for that session

#### Scenario: Session deletion discards the session's state
- **WHEN** a session-deleted event is received for a session
- **THEN** that session's recorded title and its open permission and input-request notification handles are discarded

### Requirement: Permission Request Notification
The system SHALL send a notification when a permission request is asked, composing the notification body from the requested action and resource(s), and SHALL dismiss that notification when the corresponding reply is received.

#### Scenario: Permission request notification is sent
- **WHEN** a permission request is asked for a session
- **THEN** a notification is sent describing the requested action and resource(s), regardless of whether the session's window currently has focus

#### Scenario: Permission notification is dismissed on reply
- **WHEN** a reply is received for a previously notified permission request
- **THEN** the corresponding notification is dismissed

#### Scenario: A reply arriving before the notification handle is available is not left open
- **WHEN** a reply is received for a permission request whose notification has not yet finished being sent
- **THEN** the notification is dismissed immediately once it is sent, rather than being left open indefinitely

#### Scenario: A duplicate ask for the same request replaces the prior notification
- **WHEN** a second permission-asked event arrives for a request ID that already has an open notification
- **THEN** the prior notification is dismissed before the new one is sent

### Requirement: Task Finished Notification
The system SHALL send a notification when a session becomes idle after finishing a task, optionally suppressed when the user is currently viewing the session's window.

#### Scenario: Notifies when a session becomes idle
- **WHEN** a session becomes idle after completing a task
- **THEN** a notification is sent naming the session

#### Scenario: Suppressed when the session window is focused
- **WHEN** a session becomes idle and the configuration has not disabled focus-based suppression, and the user's window is currently focused on that session
- **THEN** no notification is sent

### Requirement: Session Failure Notification
The system SHALL send a notification when a session fails, and SHALL include any available failure message in the notification body when the underlying event provides one.

#### Scenario: Notifies on session failure
- **WHEN** a session fails
- **THEN** a notification is sent naming the session

#### Scenario: Includes failure detail when available
- **WHEN** a session failure event provides an error message
- **THEN** that message is included in the notification body alongside the session name

### Requirement: User-Input Request Notification
The system SHALL send a notification when the system asks the user a question or requests input via a form, using that request's title as the notification heading, and SHALL dismiss the notification when the request is replied to or cancelled.

#### Scenario: Notifies when user input is requested
- **WHEN** the system asks the user a question or presents an input form
- **THEN** a notification is sent using the request's title

#### Scenario: Notification is dismissed on reply or cancellation
- **WHEN** a reply or cancellation is received for a previously notified input request
- **THEN** the corresponding notification is dismissed

#### Scenario: A duplicate request replaces the prior notification
- **WHEN** a second input request arrives for a request ID that already has an open notification
- **THEN** the prior notification is dismissed before the new one is sent

### Requirement: User-Provided Answer Content Is Never Forwarded
The system SHALL NOT include the user's answer content in any notification or webhook payload for a resolved input request.

#### Scenario: Answer content is absent from the dismissal payload
- **WHEN** an input request is replied to and its notification is dismissed
- **THEN** neither the notification dismissal nor any webhook payload for that event contains the user's answer text

### Requirement: Webhook Dispatch
The system SHALL, for each event type it notifies on, POST a JSON payload to every configured webhook URL when webhooks are configured, using stable event and field names that do not vary based on which runtime produced the underlying event.

#### Scenario: Webhook fires alongside a desktop notification
- **WHEN** one or more webhook URLs are configured and a notifiable event occurs
- **THEN** a JSON payload is POSTed to every configured URL, concurrently, containing the event's stable name and relevant session/request identifiers

#### Scenario: Webhook field names are stable across runtimes
- **WHEN** the same logical event (e.g. a session failure) is produced by different underlying event sources
- **THEN** the webhook payload's event name and field names are identical, with any runtime-specific extra detail (e.g. an error message) added only as an additive optional field

### Requirement: Per-Event Notification Toggles
The system SHALL allow each notification category to be independently enabled or disabled via configuration, defaulting every category to enabled when unspecified.

#### Scenario: A disabled category produces no notification
- **WHEN** a notification category is explicitly disabled in configuration
- **THEN** no desktop notification or webhook payload is produced for that category's events

### Requirement: Todo Notifications Are Unsupported On Some Runtimes
The system SHALL NOT emit todo-completion notifications, and SHALL emit exactly one startup warning when the todo-notification setting is explicitly present in configuration, so the gap is discoverable rather than silent.

#### Scenario: No todo notifications fire on a runtime with no todo event source
- **WHEN** any event is received, regardless of configuration
- **THEN** no todo-completion notification is sent

#### Scenario: A startup warning is emitted only when todo notifications were explicitly configured
- **WHEN** the system starts and the todo-notification setting was explicitly present in configuration, from the config file or from plugin options
- **THEN** exactly one warning is logged at startup noting that todo notifications are unavailable

#### Scenario: No startup warning when todo notifications were never configured
- **WHEN** the system starts and the todo-notification setting was never explicitly configured
- **THEN** no warning about the missing feature is logged

### Requirement: Malformed Or Unhandled Events Never Halt Processing
The system SHALL continue processing subsequent events after encountering a malformed event or an internal failure while handling one event, and SHALL silently ignore event types it does not recognize.

#### Scenario: A handler failure does not stop subsequent notifications
- **WHEN** processing one event raises an internal error
- **THEN** that error is logged and event processing continues for all subsequent events

#### Scenario: Unrecognized event types are ignored
- **WHEN** an event of a type the system does not handle is received
- **THEN** it is ignored without error and without affecting any other event's processing

### Requirement: Plugin Options Override The Config File
The system SHALL apply options supplied to the plugin by the host over the same options read from the config file, merging notification categories individually.

#### Scenario: Plugin option overrides the config file
- **WHEN** the config file and the plugin options both set the same top-level option
- **THEN** the plugin option's value is used

#### Scenario: Notification categories merge individually
- **WHEN** the config file configures one notification category and the plugin options configure a different category
- **THEN** both categories' settings are applied

### Requirement: Task Finished Notification Fires On Session Completion
The system SHALL send the task-finished notification when the host reports that a session's execution succeeded.

#### Scenario: Notifies when session execution succeeds
- **WHEN** the host reports that a session's execution succeeded
- **THEN** the task-finished notification is sent naming the session

### Requirement: Unloading The Plugin Releases Its Processes
The system SHALL stop every notification-action monitor process it started when the plugin is unloaded, and SHALL NOT start new ones afterwards.

#### Scenario: Unload stops running monitors
- **WHEN** the plugin is unloaded while a notification-action monitor process is running
- **THEN** that process is terminated

#### Scenario: A notification sent during unload starts no monitor
- **WHEN** a desktop notification finishes sending after the plugin was unloaded
- **THEN** no monitor process is started for it
