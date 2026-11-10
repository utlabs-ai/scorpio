// The topic page's shared facts, read by every module and each written only by its owner.
(function () {
  "use strict";

  var FIELDS = ["me", "cursor", "messages", "bySeq", "members", "todo", "mentionUnread", "room"];

  /**
   * init: the page's state, one value per field above; a field the store does not know throws, so a new one is added
   * here on purpose. Every field is get-only on the state every module receives. claim(field) hands out a field's one
   * setter, once: members to the members, room to the settings, the messages, cursor and mentionUnread to the feed,
   * todo to the tasks; me has none. Assigning a get-only field throws in strict mode, so a write that bypasses the
   * owner fails loudly.
   */
  window.createRoomStore = function (init) {
    var values = {}, claimed = {}, state = {};
    Object.keys(init).forEach(function (k) {
      if (FIELDS.indexOf(k) < 0) throw new Error("unknown field " + k);
      values[k] = init[k];
    });
    FIELDS.forEach(function (k) {
      Object.defineProperty(state, k, { enumerable: true, get: function () { return values[k]; } });
    });
    function claim(field) {
      if (field === "me" || FIELDS.indexOf(field) < 0) throw new Error("no setter for " + field);
      if (claimed[field]) throw new Error(field + " is already claimed");
      claimed[field] = true;
      return function (v) { values[field] = v; };
    }
    return { state: state, claim: claim };
  };
})();
