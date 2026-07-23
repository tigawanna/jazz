export type JazzPluginSchema = {
  schema: {
    user: {
      fields: {
        accountID: {
          type: "string";
          required: false;
          input: false;
        };
        encryptedCredentials: {
          type: "string";
          required: false;
          input: false;
          returned: false;
        };
      };
    };
  };
};
