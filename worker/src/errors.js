// Errors whose message is written for the owner and safe to show in the chat. Anything else is
// reported as a generic failure, so internal runtime or storage details never reach the page.
export class PublicError extends Error {}
export class UserError extends PublicError {constructor(status,message) {super(message);this.status=status;}}
