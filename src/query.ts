import {
  AbiRegistry,
  Address,
  ResultsParser,
  SmartContract,
  TokenIdentifierValue,
} from "@multiversx/sdk-core/out";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers/out";
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", {
  timeout: 10000,
});
export const scQuery = async (
  strAddress: string,
  abiUrl: any,
  funcName = "",
  args: any[] = []
) => {
  try {
    const address = new Address(strAddress);
    const abiRegistry = await AbiRegistry.create(abiUrl);
    const contract = new SmartContract({
      address: address,
      abi: abiRegistry,
    });

    let interaction = contract.methods[funcName](args);
    const query = interaction.check().buildQuery();
    const queryResponse = await provider.queryContract(query);

    const data = new ResultsParser().parseQueryResponse(
      queryResponse,
      interaction.getEndpoint()
    );

    return data;
  } catch (error) {
    console.log(`query error for ${funcName}  : , error`);
    throw error;
  }
};

import bondingAbi from "./abi/bonding.abi.json";
// import masterAbi from "./abi/master.abi.json";
export const getMarketCap = async (contractAddress: string) => {
  const result = await scQuery(contractAddress, bondingAbi, "getReserve", [
    new TokenIdentifierValue("MAXI-1909e6"),
  ]);
  console.log("result", result.firstValue?.valueOf().toString());

  return result.firstValue?.valueOf().toString();
};
getMarketCap("erd1qqqqqqqqqqqqqpgq25hzp745kwc46f6ahlsjgder3h9jexc5ptzscwjs4j");
