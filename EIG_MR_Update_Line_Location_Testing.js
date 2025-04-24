/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * Task          Date                Author
 * Version-4     05 Dec 2024       vigneshwaran.p@zenardy.com
 */
define([
  "N/search",
  "N/record",
  "N/runtime",
  "./Library Script/EIG_Library_Function.js",
  "N/query",
], function (search, record, runtime, EIG_Library_Function, query) {
  function getInputData() {
    try {
      const orderRoutingSearchId = "customsearch_zen_order_routing";
      const loadOrderRoutingSearch = search.load(orderRoutingSearchId);
      return fetchSearchResults(loadOrderRoutingSearch);
    } catch (error) {
      log.error("Get Input Data-Error", error);
      return [];
    }
  }

  function fetchSearchResults(searchObj) {
    log.debug("Fetching Search Results", "Started processing...");
    logGovernanceUnit("Before Run Paged");

    let searchResult = [];
    let resultSet = searchObj.run();
    let index = 0;
    let pageSize = 1000;

    while (true) {
      let resultSlice = resultSet.getRange({
        start: index,
        end: index + pageSize,
      });

      if (!resultSlice || resultSlice.length === 0) {
        break; // Stop if no more records
      }

      searchResult = searchResult.concat(resultSlice); // Merge results
      index += pageSize;
    }
    logGovernanceUnit("After Run Paged");

    log.debug("Total Records Retrieved", searchResult.length);
    return searchResult;
  }

  function map(context) {
    try {
      let skuTable = retriveSKUTable();
      //log.debug("skuTable", skuTable);
      const parsedValues = JSON.parse(context.value);
      const salesOrderId = parsedValues?.id;
      context.write(salesOrderId, skuTable);
      logGovernanceUnit("Map");
    } catch (error) {
      log.error("Map Function-Error", error);
    }
  }
  function retriveSKUTable() {
    var customrecord_eig_sku_tableSearchObj = search.create({
      type: "customrecord_eig_sku_table",
      filters: [["isinactive", "is", "F"]],
      columns: [
        search.createColumn({ name: "internalid", label: "Internal ID" }),
        search.createColumn({
          name: "custrecord_eig_orginal_sku_item",
          label: "Original SKU ",
        }),
      ],
    });
    let skuTableResult = fetchSearchResults(
      customrecord_eig_sku_tableSearchObj
    );
    return skuTableResult;
  }
  function reduce(context) {
    try {
      const key = context.key;
      var value = context.values;
      value = JSON.parse(value);
      log.debug("value", value);
      logGovernanceUnit("Reduce");

      processingSalesOrder(key, value);
    } catch (error) {
      log.error("Reduce-Error", error);
    }
  }

  function summarize(summary) {
    log.debug("summary", summary);
  }

  function processingSalesOrder(soId, skuTable) {
    try {
      //log.debug('type of skuTable',typeof skuTable);
      log.debug("SalesOrder ID", soId);
      const saleOrder = record.load({
        type: "salesorder",
        id: soId,
        isDynamic: true,
      });

      const latitude = saleOrder.getValue({
        fieldId: "custbody_customerlatitude",
      });
      const longitude = saleOrder.getValue({
        fieldId: "custbody_customerlogitude",
      });
      var lineCount = saleOrder.getLineCount({ sublistId: "item" });
      let subrec = saleOrder.getSubrecord({
        fieldId: "shippingaddress",
      });
      let country = subrec.getValue({
        fieldId: "country",
      });
      log.debug("country", country);
      let safteySavedSearchId = "customsearch_item_search";
      if (country == "CA") {
        safteySavedSearchId = "customsearch_item_search_ca";
      }

      safteySavedSearchId = search.load(safteySavedSearchId);
      var locationValues = fetchSearchResults(safteySavedSearchId) || [];
      //log.debug("locationValues", locationValues);
      let line = 0;
      for (let i = 0 + line; i < lineCount; i++) {
        log.debug("Start of I", i);
        saleOrder.selectLine("item", i);
        let quantity = saleOrder.getCurrentSublistValue("item", "quantity");
        if (quantity == 0) continue;
        line = processLineItem(
          saleOrder,
          i,
          latitude,
          longitude,
          locationValues,
          skuTable
        );
        if (!line) continue;
        i = line[0];
        let updateLocation = line[1];
        log.debug("Line", line);
        log.debug("Update I", i);
        log.debug("before locationValues.length", locationValues.length);
        log.debug("updateLocation.length", updateLocation.length);

        if (updateLocation.length > 0) {
          locationValues = updateLocationValues(updateLocation, locationValues);
        }
        log.debug("after locationValues.length", locationValues.length);

        lineCount = saleOrder.getLineCount({ sublistId: "item" });
      }
      let updateLineCount = saleOrder.getLineCount({ sublistId: "item" });

      for (let i = 0; i < updateLineCount; i++) {
       // checkAssemblyItem(saleOrder, i);
        saleOrder.selectLine("item", i);
        saleOrder.setCurrentSublistValue(
          "item",
          "custcol_eig_so_line_id",
          `L${i + 1}`
        );
        saleOrder.commitLine("item");
       // updateLineCount = saleOrder.getLineCount({ sublistId: "item" });
      }
      ensureInventoryItemsHaveSameLocation(saleOrder);
      saleOrder.setValue("custbody_isorderroutingcompleted", true);

      try {
        let salesOrderID = saleOrder.save();
        log.debug("salesOrderID", salesOrderID);
      } catch (error) {
        if (error.name == "RCRD_HAS_BEEN_CHANGED") {
          saleOrder.save();
        } else if (error.name == "INVALID_TAX_CODE") {
          saleOrder.save();
        }
        log.error("Catch Error", error);
      }
    } catch (error) {
      log.error("Processing SO - Error", error);
    }
  }
  function updateLocationValues(updateLocation, locationValues) {
    // Create a new array to store updated location values
    let updatedLocationValues = locationValues.map((location) => {
      const locationData = location.getAllValues();

      // Check if this location needs to be updated
      updateLocation.forEach((update) => {
        if (
          locationData &&
          locationData.inventorylocation[0].value === update.location &&
          location.id === update.substituteItem
        ) {
          // Log before update
          log.debug("before locationData", locationData);
          log.debug("update", update);

          // Convert current quantity available to a number and update it
          let currentQty =
            parseFloat(locationData.locationquantityavailable) || 0;
          let formulaNumeric = parseFloat(locationData.formulanumeric) || 0;

          // Update the quantities
          locationData.locationquantityavailable = (
            currentQty - update.findPCkQty
          ).toString();
          locationData.formulanumeric = (
            formulaNumeric - update.findPCkQty
          ).toString();

          // Log after update
          log.debug("after locationData", locationData);
        }
      });

      // Return the updated location object
      return {
        ...location,
        getAllValues: () => locationData, // Ensure getAllValues returns the updated data
      };
    });

    return updatedLocationValues; // Return the updated locationValues array
  }

  // Example usage

  // Example usage

  function ensureInventoryItemsHaveSameLocation(saleOrder) {
    const lineCount = saleOrder.getLineCount({ sublistId: "item" });
    let firstLocation = null;
    let allSameLocation = true;

    // First pass: Check if all inventory items have the same location
    for (let i = 0; i < lineCount; i++) {
      saleOrder.selectLine({ sublistId: "item", line: i });

      const currentItemType = saleOrder.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "itemtype",
      });

      if (currentItemType === "InvtPart") {
        let quantity = saleOrder.getCurrentSublistValue("item", "quantity");
        if (quantity == 0) continue;
        const currentLocation = saleOrder.getCurrentSublistValue({
          sublistId: "item",
          fieldId: "location",
        });

        if (firstLocation === null) {
          firstLocation = currentLocation;
        } else if (firstLocation !== currentLocation) {
          allSameLocation = false;
          break;
        }
      }
    }

    // Second pass: Set location to empty if they differ
    if (!allSameLocation) {
      for (let i = 0; i < lineCount; i++) {
        saleOrder.selectLine({ sublistId: "item", line: i });
        const currentItemType = saleOrder.getCurrentSublistValue({
          sublistId: "item",
          fieldId: "itemtype",
        });

        if (currentItemType === "InvtPart") {
          let quantity = saleOrder.getCurrentSublistValue("item", "quantity");
          if (quantity == 0) continue;
          saleOrder.setCurrentSublistValue("item", "location", "");
          saleOrder.commitLine("item");
        }
      }
    }
  }
  function processLineItem(
    saleOrder,
    lineIndex,
    latitude,
    longitude,
    locationValues,
    skuTable
  ) {
    saleOrder.selectLine({ sublistId: "item", line: lineIndex });

    const itemType = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "itemtype",
    });
    if (itemType === "Kit" || itemType === "Service") return; // Skip Kits

    var getItem = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "item",
    });
    var SOItem = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "item",
    });
    const getItemName = saleOrder.getCurrentSublistText({
      sublistId: "item",
      fieldId: "item",
    });
    const itemAvailable = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "quantityavailable",
    });
    let _isSellAsPair_ = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "custcol_sell_as_pair",
    });
    const quantity = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "quantity",
    });
    if (quantity == 0) return;
    const isInvoiced = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "quantitybilled",
    });
    const rate = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "rate",
    });
    const classification = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "class",
    });
    const is_split_item = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "custcol_eig_is_split_item",
    });
    const dept = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "department",
    });
    const kitName = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "custcol_kit_packagememo",
    });
    const taxCode = saleOrder.getCurrentSublistValue({
      sublistId: "item",
      fieldId: "taxcode",
    });
    let getProcessingValues = handleSubstituteItems(
      getItem,
      getItemName,
      quantity,
      latitude,
      longitude,
      lineIndex,
      saleOrder.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "quantityavailable",
      }),
      locationValues,
      skuTable
    );
    let line_i = 0;

    log.debug("getProcessingValues", getProcessingValues);
    const orginalSKUArray = getProcessingValues.orginalSKUArrayValue || [];
    const substituteArray = getProcessingValues.substitueArray || [];

    log.debug(`${getItemName} Processing Values`, {
      orginalSKUArray,
      substituteArray,
    });

    let orderQty = quantity;
    let combinedArray = [...orginalSKUArray, ...substituteArray];
    log.debug("Before Sort Array", combinedArray);
    combinedArray.sort((a, b) => {
      const distanceA =
        a.distance !== undefined ? a.distance : a.location[0].distance;
      const distanceB =
        b.distance !== undefined ? b.distance : b.location[0].distance;
      if (distanceA !== distanceB) {
        return distanceA - distanceB; // Ascending order
      } else {
        // If distances are the same, fall back to sorting by linePCK or another attribute as needed
        let PCKA = a.SKUPCK !== undefined ? a.SKUPCK : a.location[0].linePCK;
        let PCKB = b.distance !== undefined ? b.SKUPCK : b.location[0].linePCK;

        return PCKB - PCKA;
      }
    });
    log.debug("After Sort Array", combinedArray);
    let isMultiBox = getProcessingValues.isMultiBox || false;
    if (!isMultiBox) {
      let lineArray = [];
      try {
        for (let i = 0; i < combinedArray.length; i++) {
          //log.debug('combinedArray Start', combinedArray);
          let currentObj = combinedArray[i];
          if (orderQty == 0) {
            break;
          }
          try {
            if (currentObj.itemId) {
              log.debug("Substitute Process");
            } else {
              log.debug("Original Process");
            }
          } catch (error) {
            log.error("Check Condtion Error", error);
          }
          if ("itemId" in currentObj) {
            let skuPCK = combinedArray[i].location[0].SKUPCK;
            let substitutePCK = combinedArray[i].location[0].linePCK;
            let isPCkPossible = skuPCK / substitutePCK;
            if (isPCkPossible < 0) continue;

            let substituteAvailable =
              combinedArray[i].location[0].availableQuantity[0].qty;
            let substituteItem = combinedArray[i].location[0].getItem;
            let substituteQty = combinedArray[i].location[0].subsituteQuantity;

            let location =
              combinedArray[i].location[0].availableQuantity[0].locationID[0]
                .value;
            let rawQuantity = orderQty * skuPCK;
            log.debug("rawQuantity", rawQuantity);
            let findPCkQty = Math.floor(rawQuantity / substitutePCK);
            let findRemaingQty = rawQuantity % substitutePCK;
            log.debug("findPCkQty", findPCkQty);
            log.debug("findRemaingQty", findRemaingQty);
            log.debug("substituteAvailable", substituteAvailable);

            if (substituteAvailable == 0) continue;
            log.debug("findPCkQty", findPCkQty);
            if (findPCkQty == 0) continue;
            let remainingQty = substituteAvailable - findPCkQty;
            log.debug(remainingQty);
            if (remainingQty > 0) {
              log.debug({
                substituteItem,
                findPCkQty,
                location,
                substituteQty,
              });
              lineArray.push({
                substituteItem,
                findPCkQty,
                location,
                SKUPCk: skuPCK,
                substitutePCK,
                substituteQty,
                isSubstitute: true,
              });
              //   combinedArray[i].location[0].availableQuantity[0].qty = remainingQty;
              combinedArray = updateAvailabelQty(
                combinedArray,
                location,
                remainingQty,
                substituteItem
              );
              //   log.debug('combinedArray change qty', combinedArray);
              orderQty = findRemaingQty;
            } else {
              log.debug({
                substituteItem,
                findPCkQty: substituteAvailable,
                location,
                substituteQty,
              });
              lineArray.push({
                substituteItem,
                findPCkQty: substituteAvailable,
                location,
                SKUPCk: skuPCK,
                substitutePCK,
                substituteQty,
                isSubstitute: true,
              });
              //   combinedArray[i].location[0].availableQuantity[0].qty = 0;
              combinedArray = updateAvailabelQty(
                combinedArray,
                location,
                0,
                substituteItem
              );
              //   log.debug('combinedArray change qty', combinedArray);

              let remaingQty = findPCkQty - substituteAvailable;
              remaingQty += findRemaingQty;
              orderQty = (remaingQty * substituteQty) / skuPCK;
              log.debug("remaingQty", remaingQty);
              log.debug("orderQty", orderQty);
            }
          } else {
            let SKUPCk = combinedArray[i].SKUPCK || 1;
            let item = combinedArray[i].item;
            let availableQuantity = combinedArray[i].availableQuantity[0].qty;
            let location =
              combinedArray[i].availableQuantity[0].locationID[0].value;
            if (availableQuantity == 0) continue;
            let processQty = availableQuantity - orderQty;
            if (processQty > 0) {
              log.debug({
                item,
                orderQty,
                location,
              });
              lineArray.push({
                substituteItem: item,
                findPCkQty: orderQty,
                location,
                SKUPCk,
                substituteQty: 1,
                isSubstitute: false,
              });
              combinedArray = updateAvailabelQty(
                combinedArray,
                location,
                processQty,
                item
              );
              //   log.debug('combinedArray change qty', combinedArray);

              orderQty = 0;
            } else {
              log.debug({
                substituteItem: item,
                findPCkQty: availableQuantity,
                location,
              });
              lineArray.push({
                substituteItem: item,
                findPCkQty: availableQuantity,
                location,
                SKUPCk,
                substituteQty: 1,
                isSubstitute: false,
              });
              combinedArray = updateAvailabelQty(
                combinedArray,
                location,
                0,
                item
              );
              //   log.debug('combinedArray change qty', combinedArray);

              orderQty -= availableQuantity;
            }
            log.debug("Remainig Qty", orderQty);
          }
          if (i == combinedArray.length - 1) {
            if (orderQty != 0) {
              log.debug("We can fully fulfill for this item");
              log.debug("lineArray", lineArray);
            }
          }
          // log.debug('combinedArray End', combinedArray);
        }
        if (orderQty == 0) {
          log.debug("Lines Array", lineArray);
          lineArray.forEach((value, index) => {
            let line = directConversion(
              saleOrder,
              value.findPCkQty,
              isInvoiced,
              value.substituteItem,
              value.location,
              classification,
              dept,
              kitName,
              value.isSubstitute == true
                ? value.SKUPCk <= 1
                  ? rate * (value.SKUPCk * value.substitutePCK)
                  : rate / value.substituteQty
                : rate,
              lineIndex + index,
              index,
              value.SKUPCk,
              _isSellAsPair_,
              is_split_item,
              taxCode
            );
            line_i = line;
          });
          log.debug("Line", line_i);
          return [line_i, lineArray];
        } else {
          log.debug("Else Lines Array", lineArray);

          saleOrder.setCurrentSublistValue(
            "item",
            "custcol_eig_is_failed_line",
            true
          );
          saleOrder.setCurrentSublistValue(
            "item",
            "custcol_eig_failed_reason",
            {
              Item: lineArray,
              Reason: `We Can't Fulfill for this ${getItemName} Item`,
            }
          );
          line_i = lineIndex;
          saleOrder.commitLine("item");
          // log.debug("Line", line_i);
          // return [line_i, []];
        }
      } catch (error) {
        log.error("Process Line Item Error", error);
      }
    } else {
      let combinedArray = [];

      // Add original items to combined array
      orginalSKUArray.forEach((originalItem) => {
        combinedArray.push({
          isSubstitute: false,
          itemId: originalItem.item, // Assign original item as itemId
          distance: originalItem.distance,
          SKUPCK: originalItem.SKUPCK,
          item: originalItem.item,
          itemLineID: originalItem.itemLineID,
          availableQuantity: originalItem.availableQuantity,
        });
      });

      // Process substitute items
      if (substituteArray.length > 0) {
        substituteArray.forEach((substitute) => {
          substitute.location.forEach((location) => {
            combinedArray.push({
              isSubstitute: true,
              itemId: substitute.itemId,
              itemName: location.itemText,
              quantityOrdered: substitute.quantityOrdered,
              remainingToCommit: substitute.remainingToCommit,
              distance: location.distance,
              orginalSKUPck: location.SKUPCK,
              linePCK: location.linePCK,
              subsituteQuantity: location.subsituteQuantity,
              item: location.item,
              itemLineID: location.itemLineID,
              availableQuantity: location.availableQuantity,
              substitutePriority: location.substitutePriority,
            });
          });
        });
      }
      log.debug("Combined Array Before Sort",combinedArray);
      combinedArray.sort((a, b) => {
        // Sort by distance (ascending)
        if (a.distance !== b.distance) {
          return a.distance - b.distance;
        }

        // Sort by packing unit (linePCK or SKUPCK) in descending order
        let PCKA =
          a.linePCK !== undefined && a.linePCK !== ""
            ? parseInt(a.linePCK)
            : a.SKUPCK !== undefined
            ? parseInt(a.SKUPCK)
            : 0;
        let PCKB =
          b.linePCK !== undefined && b.linePCK !== ""
            ? parseInt(b.linePCK)
            : b.SKUPCK !== undefined
            ? parseInt(b.SKUPCK)
            : 0;

        if (PCKA !== PCKB) {
          return PCKB - PCKA; // Higher PCK value comes first
        }

        // Prioritize original SKUs over substitutes (isSubstitute: false comes first)
        return a.isSubstitute === b.isSubstitute ? 0 : a.isSubstitute ? 1 : -1;
      });

      // Step 2: Group by box key (distance + locationID + substitutePriority)
      const groupedBoxes = {};

    //  log.debug("combinedArray", combinedArray);
      combinedArray.forEach((item) => {
        const distance = item.distance;
        const locationID =
          item.availableQuantity?.[0]?.locationID?.[0]?.value || "unknown";
        const priority = item.isSKU ? "0" : item.substitutePriority;
        const boxKey = `${distance}-${locationID}-${priority}`;

        if (!groupedBoxes[boxKey]) {
          groupedBoxes[boxKey] = [];
        }
        groupedBoxes[boxKey].push(item);
      });

      // Step 3: Filter out single-item boxes (keep only boxes with 2+ items)
      const filteredArray = [];

      Object.values(groupedBoxes).forEach((box) => {
        // Check if the box contains an original SKU
        const hasSKU = box.some((item) => item.isSKU);

        // If the box has an original SKU or has at least 2 items, include all items from the box
        if (hasSKU || box.length >= 2) {
          filteredArray.push(...box);
        }
      });
      filteredArray.sort((a, b) => {
        // 1. Sort by distance (ascending)
        if (a.distance !== b.distance) {
            return a.distance - b.distance;
        }
    
        // 2. Prioritize substitutes if distances are equal
        if (!a.isSubstitute && b.isSubstitute) return -1;
        if (a.isSubstitute && !b.isSubstitute) return 1;
    
        // 3. If both are substitutes, sort by substitute priority (ascending)
        const priorityA = parseInt(a.substitutePriority || "0");
        const priorityB = parseInt(b.substitutePriority || "0");
        return priorityA - priorityB;
    });
      log.debug("filteredArray", filteredArray);
      let linesArray = [];
      filteredArray.forEach((item, i, array) => {
        let object = item;
        //log.debug("object", object);

        if (orderQty <= 0) {
          log.debug("Break");
          return;
        }
        if (object.isSKU) {
          log.debug(
            `Original SKU - Item ID: ${object.itemId}, Distance: ${object.distance}`
          );
          let availableQuantity = object.availableQuantity[0].qty;
          let SKUPCK = object.SKUPCK;
          let item = object.itemId;
          let location = object.availableQuantity[0].locationID[0].value;
          let locationText = object.availableQuantity[0].locationID[0].text;

          if (availableQuantity == 0) return;
          let processQty = availableQuantity - orderQty;
          if (processQty > 0) {
            log.debug({
              item,
              orderQty,
              location,
            });
            linesArray.push({
              substituteItem: item,
              findPCkQty: orderQty,
              location,
              SKUPCK,
              substituteQty: 1,
              isSubstitute: false,
            });
            orderQty = 0;
          } else {
            log.debug({
              substituteItem: item,
              findPCkQty: availableQuantity,
              location,
            });
            linesArray.push({
              substituteItem: item,
              findPCkQty: availableQuantity,
              location,
              SKUPCK,
              substituteQty: 1,
              isSubstitute: false,
            });
            orderQty -= availableQuantity;
          }
        } else if (item.isSubstitute) {
          let skuPCK = object.orginalSKUPck;
          let distance = object.distance;
          let substitutePCK = object.linePCK;
          let isPCkPossible = skuPCK / substitutePCK;
          log.debug("isPCkPossible", isPCkPossible);
          if (isPCkPossible > 0) {
            let substituteAvailable = object.availableQuantity[0].qty;
            let substituteItem = object.itemId;
            let subsituteQuantity = object.subsituteQuantity;
            let location = object.availableQuantity[0].locationID[0].value;
            let locationText = object.availableQuantity[0].locationID[0].text;

            let nextItem = array[i + 1];
            // Ensure next item is a substitute and a different item
            if (
              nextItem &&
              nextItem.isSubstitute &&
              nextItem.itemId !== item.itemId &&
              distance == nextItem.distance
            ) {
              let next_skuPCK = nextItem.orginalSKUPck;
              let next_distance = nextItem.distance;
              let next_substitutePCK = nextItem.linePCK;
              let next_substituteAvailable = nextItem.availableQuantity[0].qty;
              let next_substituteItem = nextItem.itemId;
              let next_subsituteQuantity = nextItem.subsituteQuantity;
              let next_location =
                nextItem.availableQuantity[0].locationID[0].value;
              let lnext_ocationText =
                nextItem.availableQuantity[0].locationID[0].text;

              //process pck conversion and update qty
              let isPCkPossible = skuPCK / substitutePCK;
              let nextLineIsPCK = next_skuPCK / next_substitutePCK;

              if (isPCkPossible > 0 && nextLineIsPCK > 0) {
                let rawQuantity = orderQty * skuPCK;
                let rawNextLineQty = orderQty * next_skuPCK;

                //get the raw qty for both lines
                log.debug("rawQuantity", rawQuantity);
                log.debug("rawNextLineQty", rawNextLineQty);

                //find the pck qty for both lines
                let findPCkQty = Math.floor(rawQuantity / substitutePCK);
                let nextFindPCkQty = Math.floor(
                  rawQuantity / next_substitutePCK
                );
                log.debug("findPCkQty", findPCkQty);
                log.debug("nextFindPCkQty", nextFindPCkQty);

                //find remaing qty for both lines
                let findRemaingQty = rawQuantity % substitutePCK;
                let nextFindRemaingQty = rawQuantity % next_substitutePCK;
                log.debug("findRemaingQty", findRemaingQty);
                log.debug("nextFindRemaingQty", nextFindRemaingQty);

                log.debug("substituteAvailable", substituteAvailable);
                log.debug("next_substituteAvailable", next_substituteAvailable);
                if (substituteAvailable != 0 && next_substituteAvailable != 0) {
                  let line_1_qty = Math.min(findPCkQty, substituteAvailable);
                  let line_2_qty = Math.min(
                    nextFindPCkQty,
                    next_substituteAvailable
                  );

                  log.debug("line_1_qty", line_1_qty);
                  log.debug("line_2_qty", line_2_qty);

                  let takeProcessQty = Math.min(line_1_qty, line_2_qty);
                  log.debug("takeProcessQty", takeProcessQty);

                  if (findPCkQty == 0) return;
                  let remainingQty = substituteAvailable - findPCkQty;
                  let nextLineRemaingQty =
                    next_substituteAvailable - takeProcessQty;
                  log.debug("remainingQty", remainingQty);
                  log.debug("nextLineRemaingQty", nextLineRemaingQty);

                  if (remainingQty > 0 && nextLineRemaingQty > 0) {
                    log.debug("Line 1", {
                      substituteItem,
                      findPCkQty,
                      location,
                      subsituteQuantity,
                    });
                    log.debug("Line 2", {
                      next_substituteItem,
                      nextFindPCkQty,
                      next_location,
                      next_subsituteQuantity,
                    });

                    linesArray.push({
                      substituteItem,
                      findPCkQty,
                      location,
                      SKUPCk: skuPCK,
                      substitutePCK,
                      subsituteQuantity,
                      isSubstitute: true,
                    });
                    linesArray.push({
                      substituteItem: next_substituteItem,
                      findPCkQty: takeProcessQty,
                      location: next_location,
                      SKUPCk: next_skuPCK,
                      substitutePCK: next_substitutePCK,
                      subsituteQuantity: next_subsituteQuantity,
                      isSubstitute: true,
                    });

                    orderQty = findRemaingQty;
                  } else {
                    log.debug("Line 1", {
                      substituteItem,
                      findPCkQty: takeProcessQty,
                      location,
                      subsituteQuantity,
                    });
                    log.debug("Line 2", {
                      next_substituteItem,
                      findPCkQty: takeProcessQty,
                      next_location,
                      next_subsituteQuantity,
                    });

                    linesArray.push({
                      substituteItem,
                      findPCkQty: takeProcessQty,
                      location,
                      SKUPCk: skuPCK,
                      substitutePCK,
                      subsituteQuantity,
                      isSubstitute: true,
                    });
                    linesArray.push({
                      substituteItem: next_substituteItem,
                      findPCkQty: takeProcessQty,
                      location: next_location,
                      SKUPCk: next_skuPCK,
                      substitutePCK: next_substitutePCK,
                      subsituteQuantity: next_subsituteQuantity,
                      isSubstitute: true,
                    });
                    let remaingQty = findPCkQty - takeProcessQty;
                    remaingQty += findRemaingQty;

                    orderQty = (remaingQty * subsituteQuantity) / skuPCK;
                    log.debug("remaingQty", remaingQty);
                    log.debug("orderQty", orderQty);
                    orderQty =
                      (remaingQty * next_subsituteQuantity) / next_skuPCK;

                    log.debug("nextLineRemaingQty", remaingQty);
                    log.debug("orderQty", orderQty);
                  }
                }
              }
              i++;
            }
          }
        }
      });

      if (orderQty == 0) {
        log.debug("Lines Array", linesArray);
        let substituteLength = linesArray.filter(
          (obj) => obj.isSubstitute
        ).length;

        linesArray.forEach((value, index) => {
          log.debug(index, value);
          let line = directConversion(
            saleOrder,
            value.findPCkQty,
            isInvoiced,
            value.substituteItem,
            value.location,
            classification,
            dept,
            kitName,
            value.isSubstitute == true ? rate / substituteLength : rate,
            lineIndex + index,
            index,
            value.SKUPCk,
            _isSellAsPair_,
            is_split_item,
            taxCode
          );
          line_i = line;
          log.debug("line_i", line_i);
          log.debug("line", line);
        });
        log.debug("Line", line_i);
        return [line_i, linesArray];
      } else {
        log.debug("Else Lines Array", linesArray);

        saleOrder.setCurrentSublistValue(
          "item",
          "custcol_eig_is_failed_line",
          true
        );
        saleOrder.setCurrentSublistValue("item", "custcol_eig_failed_reason", {
          Item: linesArray,
          Reason: `We Can't Fulfill for this ${getItemName} Item`,
        });
        line_i = lineIndex;
        saleOrder.commitLine("item");
        // log.debug("Line", line_i);
        // return [line_i, []];
      }
    }
  }

  function updateAvailabelQty(
    combinedArray,
    targetLocationID,
    newQuantity,
    targetItemID
  ) {
    combinedArray.forEach((arr) => {
      // Check for original SKU
      if (
        arr.availableQuantity && // Check for availableQuantity in original SKU
        arr.availableQuantity.length > 0 &&
        arr.availableQuantity[0].locationID &&
        arr.availableQuantity[0].locationID.length > 0 &&
        arr.availableQuantity[0].locationID[0].value === targetLocationID &&
        arr.item === targetItemID // Check if the item matches
      ) {
        // Update the quantity of the matched object
        arr.availableQuantity[0].qty = newQuantity;
      } else if (
        arr.location && // Check for location in substitute
        arr.location.length > 0 &&
        arr.location[0].availableQuantity &&
        arr.location[0].availableQuantity.length > 0 &&
        arr.location[0].availableQuantity[0].locationID &&
        arr.location[0].availableQuantity[0].locationID.length > 0 &&
        arr.location[0].availableQuantity[0].locationID[0].value ===
          targetLocationID &&
        arr.itemId === targetItemID // Check if the item matches
      ) {
        // Update the quantity of the matched object in substitute
        arr.location[0].availableQuantity[0].qty = newQuantity;
      }
    });
    return combinedArray;
  }
  function directConversion(
    saleOrder,
    quantity,
    isInvoiced,
    SKUItem,
    SKULocation,
    classification,
    dept,
    kitName,
    rate,
    lineIndex,
    index,
    SKUPCk,
    _isSellAsPair_,
    is_split_item,
    taxCode
  ) {
    log.debug("lineIndex", lineIndex);
    log.debug("Values", {
      quantity,
      SKUItem,
      SKULocation,
    });
    //let idealLocation = saleOrder.getValue('custbody_eig_ideal_location');
    if (quantity > 0) {
      if (isInvoiced != 0) {
        if (index == 0) {
          saleOrder.setCurrentSublistValue("item", "rate", 0);
          saleOrder.setCurrentSublistValue("item", "quantity", 0);
          saleOrder.setCurrentSublistValue("item", "location", "");
          saleOrder.commitLine("item");
        }
        saleOrder.insertLine("item", lineIndex + 1);
        saleOrder.setCurrentSublistValue("item", "item", SKUItem);
        saleOrder.setCurrentSublistValue("item", "location", SKULocation);
        saleOrder.setCurrentSublistValue("item", "class", classification);
        saleOrder.setCurrentSublistValue("item", "department", dept);
        saleOrder.setCurrentSublistValue(
          "item",
          "custcol_sell_as_pair",
          _isSellAsPair_
        );
        if (!!taxCode) {
          saleOrder.setCurrentSublistValue("item", "taxcode", taxCode);
        }
        saleOrder.setCurrentSublistValue(
          "item",
          "custcol_eig_is_split_item",
          is_split_item
        );

        saleOrder.setCurrentSublistValue(
          "item",
          "custcol_kit_packagememo",
          kitName
        );
        saleOrder.setCurrentSublistValue("item", "quantity", quantity);
        saleOrder.setCurrentSublistValue("item", "rate", rate);
        saleOrder.commitLine("item");
        lineIndex++;
        log.debug("lineIndex", lineIndex);
      } else {
        log.debug("lineIndex", lineIndex);
        if (index == 0) {
          saleOrder.removeLine({ sublistId: "item", line: lineIndex });
        }
        saleOrder.insertLine("item", lineIndex);
        saleOrder.setCurrentSublistValue("item", "item", SKUItem);
        saleOrder.setCurrentSublistValue("item", "location", SKULocation);
        saleOrder.setCurrentSublistValue("item", "class", classification);
        saleOrder.setCurrentSublistValue("item", "department", dept);
        saleOrder.setCurrentSublistValue(
          "item",
          "custcol_sell_as_pair",
          _isSellAsPair_
        );
        saleOrder.setCurrentSublistValue(
          "item",
          "custcol_eig_is_split_item",
          is_split_item
        );
        saleOrder.setCurrentSublistValue(
          "item",
          "custcol_kit_packagememo",
          kitName
        );
        if (!!taxCode) {
          saleOrder.setCurrentSublistValue("item", "taxcode", taxCode);
        }
        saleOrder.setCurrentSublistValue("item", "quantity", quantity);
        saleOrder.setCurrentSublistValue("item", "rate", rate);
        saleOrder.commitLine("item");
      }
      log.debug("lineIndex", lineIndex);
    }
    log.debug("lineIndex", lineIndex);

    return lineIndex;
  }
  function handleSubstituteItems(
    getItem,
    getItemName,
    quantity,
    latitude,
    longitude,
    lineIndex,
    itemAvailable,
    locationValues,
    skuTable
  ) {
    const SKUTableId = getSKUItemTable(getItem, skuTable);
    log.debug("SKUTableId", SKUTableId);
    let orginalSKUArrayValue = [];
    let substitueArray = [];
    if (!!SKUTableId) {
      const SKUTable = record.load({
        type: "customrecord_eig_sku_table",
        id: SKUTableId,
      });
      let orginalSKUQuantity = SKUTable.getValue(
        "custrecord_eig_orginal_sku_quantity"
      );
      let isMultiBox = SKUTable.getValue("custrecord_eig_is_multibox");
      let SKUPCK = SKUTable.getValue("custrecord_eig_pack");
      orginalSKUArrayValue = processAvailableItems(
        getItem,
        quantity,
        latitude,
        longitude,
        lineIndex,
        itemAvailable,
        locationValues,
        orginalSKUQuantity,
        SKUPCK
      );
      substitueArray =
        processSubstituteItems(
          SKUTable,
          getItemName,
          quantity,
          latitude,
          longitude,
          lineIndex,
          locationValues,
          SKUPCK,
          isMultiBox
        ) || [];
      log.debug("substitueArray", substitueArray);
      log.debug("orginalSKUArrayValue", orginalSKUArrayValue);
      const separatedItems = [];

      substitueArray.forEach((item) => {
        item.location.forEach((loc) => {
          // Create a new object for each location
          const newItem = {
            itemId: item.itemId,
            itemName: item.itemName,
            quantityOrdered: item.quantityOrdered,
            remainingToCommit: item.remainingToCommit,
            location: [loc], // Wrap the location in an array
          };
          separatedItems.push(newItem);
        });
      });
      if (separatedItems.length > 0) {
        // log.debug('Before Sort - substitueArray', substitueArray);

        separatedItems.forEach((item) => {
          item.location.sort((a, b) => {
            return parseFloat(a.distance) - parseFloat(b.distance);
          });
        });
        // log.debug('After Sort - substitueArray', substitueArray);
      }

      let SKUObj = {
        orginalSKUArrayValue,
        substitueArray: separatedItems,
        isMultiBox,
      };
      return SKUObj;
    } else {
      orginalSKUArrayValue = processAvailableItems(
        getItem,
        quantity,
        latitude,
        longitude,
        lineIndex,
        itemAvailable,
        locationValues,
        1,
        1
      );
      let SKUObj = {
        orginalSKUArrayValue,
        isMultiBox: false,
      };
      log.debug("Without SKU Table-orginalSKUArrayValue", orginalSKUArrayValue);
      return SKUObj;
    }
  }

  function processAvailableItems(
    getItem,
    quantity,
    latitude,
    longitude,
    lineIndex,
    itemAvailable,
    locationValues,
    orginalSKUQuantity,
    SKUPCK
  ) {
    if (itemAvailable > 0) {
      locationValues;
      //log.audit(`nearestWarehouse for this ${getItem} Line is ${lineIndex}`);

      const nearestWarehouse =
        getNearestWarehousesForSubstitute(
          getItem,
          latitude,
          longitude,
          locationValues
        ) || [];
      log.debug(`nearestWarehouse for this ${getItem}`, nearestWarehouse);
      if (nearestWarehouse.length > 0) {
        return allocateItemsToWarehouses(
          nearestWarehouse,
          quantity,
          lineIndex,
          orginalSKUQuantity,
          SKUPCK
        );
      }
    }
    return [];
  }

  function processSubstituteItems(
    SKUTable,
    getItemName,
    quantity,
    latitude,
    longitude,
    lineIndex,
    locationValues,
    SKUPCK,
    isMultiBox
  ) {
    try {
      const lineCount = SKUTable.getLineCount(
        "recmachcustrecord_eig_sku_parent_record"
      );
      const substitueArray = [];

      for (let j = 0; j < lineCount; j++) {
        const substituteItem = SKUTable.getSublistValue({
          sublistId: "recmachcustrecord_eig_sku_parent_record",
          fieldId: "custrecord_eig_substitution_item",
          line: j,
        });
        const linePCK = SKUTable.getSublistValue({
          sublistId: "recmachcustrecord_eig_sku_parent_record",
          fieldId: "custrecord_eig_line_pack",
          line: j,
        });
        let itemText = SKUTable.getSublistText({
          sublistId: "recmachcustrecord_eig_sku_parent_record",
          fieldId: "custrecord_eig_substitution_item",
          line: j,
        });
        const substitutePriority = SKUTable.getSublistValue({
          sublistId: "recmachcustrecord_eig_sku_parent_record",
          fieldId: "custrecord_eig_substitution_priority",
          line: j,
        });
        const subsituteQuantity = SKUTable.getSublistValue({
          sublistId: "recmachcustrecord_eig_sku_parent_record",
          fieldId: "custrecord_eig_substitution_quantity",
          line: j,
        });
        log.audit(
          `nearestWarehouse for this Orginal SKU Item${getItemName} and Subtitution Item ${substituteItem} Line is ${j}`
        );
        var nearestWarehouse = [];
        nearestWarehouse =
          getNearestWarehousesForSubstitute(
            substituteItem,
            latitude,
            longitude,
            locationValues
          ) || [];
        log.debug(
          `nearestWarehouse for this Orginal SKU Item${getItemName} and Subtitution Item ${substituteItem}`,
          nearestWarehouse
        );
        if (nearestWarehouse.length > 0) {
          const linesArray = addToLinesArray({
            getItem: substituteItem,
            getItemName,
            quantity,
            nearestWarehouse,
            lineIndex,
            substitutePriority,
            subsituteQuantity,
            itemText,
            SKUPCK,
            linePCK,
          });

          log.debug("linesArray", linesArray);
          if (Object.keys(linesArray).length > 0) {
            substitueArray.push(linesArray);
          } else {
            log.debug("Else Lines Array", linesArray);
          }
        }
      }
      return substitueArray;
    } catch (error) {
      log.error("processSubstituteItems-Error", error);
    }
  }

  function allocateItemsToWarehouses(
    nearestWarehouse,
    orderQty,
    lineIndex,
    orginalSKUQuantity,
    SKUPCK
  ) {
    try {
      var orginalSKUArray = [];
      let loationThreshold = runtime
        .getCurrentScript()
        .getParameter("custscript_eig_location__threshold");
      let warehouseThreshold = Math.min(
        nearestWarehouse.length,
        loationThreshold
      );
      let RemainingQty;
      log.debug("warehouseThreshold", warehouseThreshold);
      let locationTrackArray = [];
      for (let loc = 0; loc < warehouseThreshold; loc++) {
        const resultValues = nearestWarehouse[loc].result;
        const locationAvailableToCommit = resultValues.values.formulanumeric;
        const safetyStock = resultValues.values.custitem_safety_stock;
        let location = resultValues.values.inventorylocation;
        log.audit("Location resultValues", resultValues);
        log.audit("locationAvailableToCommit", locationAvailableToCommit);
        if (locationAvailableToCommit > 0) {
          orginalSKUArray.push({
            distance: nearestWarehouse[loc].distance,
            SKUPCK: SKUPCK,
            item: resultValues.values.internalid[0].value,
            orginalSKUQuantity: orginalSKUQuantity,
            itemLineID: lineIndex,
            availableQuantity: [
              {
                qty: locationAvailableToCommit,
                locationQty: resultValues.values.formulanumeric,
                locationID: resultValues.values.inventorylocation,
              },
            ],
          });
        } else {
          log.emergency(
            `We can't fulfill from this location ${location}`,
            locationAvailableToCommit
          );
        }
        locationTrackArray.push({
          safetyStock: resultValues.values.custitem_safety_stock,
          distance: nearestWarehouse[loc].distance,
          item: resultValues.values.internalid[0].value,
          availableQuantity: [
            {
              qty: locationAvailableToCommit,
              locationQty: resultValues.values.formulanumeric,
              locationID: resultValues.values.inventorylocation,
            },
          ],
        });
      }
      log.audit("locationTrackArray", locationTrackArray);
      log.debug("Orginal SKU Nearest Location", orginalSKUArray);
      return orginalSKUArray;
    } catch (error) {
      log.error("allocateItemsToWarehouses-Error", error);
    }
  }

  function getNearestWarehouses(
    locationArray,
    latitude,
    longitude,
    item,
    locationValues
  ) {
    try {
      if (locationArray.length > 0 && locationValues.length > 0) {
        const searchResult = itemSearchForSafetyStock(
          locationArray,
          locationValues
        );
        log.debug(`searchResult for ${item}`, searchResult);
        const matchedItemLocation = matchedLocation(item, searchResult);
        log.debug(`matchedItemLocation for ${item}`, matchedItemLocation);
        if (matchedItemLocation.length == 0) return;
        return findNearestWarehouse(latitude, longitude, matchedItemLocation);
      }
    } catch (error) {
      log.error("getNearestWarehouses-Error", error);
    }
  }

  function matchedLocation(id, jsonArray) {
    return jsonArray.filter((item) => item.id === id);
  }

  function getNearestWarehousesForSubstitute(
    substituteItem,
    latitude,
    longitude,
    locationValues
  ) {
    try {
      logGovernanceUnit("Start Query");

      const suiteQL = `
            SELECT custitem_item_loc
            FROM item
            WHERE id = ?
        `;

      // Run SuiteQL with the substitute item as a parameter
      const queryResult = query.runSuiteQL({
        query: suiteQL,
        params: [substituteItem], // bind the substituteItem to the query
      });

      // Get the result as mapped data
      const results = queryResult.asMappedResults();
      log.audit("results" + substituteItem, results);
      logGovernanceUnit("End Query");
      if (results[0].custitem_item_loc == null) return;
      let substituteItemLocation = [];
      if (results.length > 0) {
        const locationValue = results[0].custitem_item_loc;
        if (locationValue) {
          substituteItemLocation = locationValue.split(","); // Split by commas
        }
        log.debug("locationValue", locationValue);
      }
      log.debug("substituteItemLocation", substituteItemLocation);
      if (substituteItemLocation.length > 0) {
        return getNearestWarehouses(
          substituteItemLocation,
          latitude,
          longitude,
          substituteItem,
          locationValues
        );
      }
    } catch (error) {
      log.error("getNearestWarehousesForSubstitute-Error", error);
    }
  }

  function addToLinesArray({
    getItem,
    getItemName,
    quantity,
    nearestWarehouse,
    lineIndex,
    substitutePriority,
    subsituteQuantity,
    itemText,
    SKUPCK,
    linePCK,
  }) {
    try {
      let remainingQty = quantity;
      const locationArray = [];
      let loationThreshold = runtime
        .getCurrentScript()
        .getParameter("custscript_eig_location__threshold");
      let warehouseThreshold = Math.min(
        nearestWarehouse.length,
        loationThreshold
      );
      let locationTrackArray = [];
      for (let loc = 0; loc < warehouseThreshold; loc++) {
        const resultValues = nearestWarehouse[loc].result;
        const locationAvailableToCommit = resultValues.values.formulanumeric;
        let location = resultValues.values.inventorylocation;
        let itemQuantity = quantity;
        log.audit("Location resultValues", resultValues);
        log.audit("locationAvailableToCommit", locationAvailableToCommit);
        locationTrackArray.push({
          distance: nearestWarehouse[loc].distance,
          item: resultValues.values.internalid[0].value,
          availableQuantity: [
            {
              qty: locationAvailableToCommit,
              locationQty: resultValues.values.formulanumeric,
              locationID: resultValues.values.inventorylocation,
            },
          ],
        });
        if (locationAvailableToCommit > 0) {
          locationArray.push({
            distance: nearestWarehouse[loc].distance,
            linePCK: linePCK,
            substitutePriority: substitutePriority,
            item: resultValues.values.internalid[0].value,
            SKUPCK: SKUPCK,
            subsituteQuantity: subsituteQuantity,
            itemText,
            getItem,
            itemLineID: lineIndex,
            availableQuantity: [
              {
                qty: locationAvailableToCommit,
                locationQty: resultValues.values.formulanumeric,
                locationID: resultValues.values.inventorylocation,
              },
            ],
          });
        } else {
          log.emergency(
            `We can't fulfill from this location ${location}`,
            locationAvailableToCommit
          );
        }
      }
      log.debug("locationTrackArray", locationTrackArray);
      return {
        itemId: getItem,
        itemName: getItemName,
        quantityOrdered: quantity,
        remainingToCommit: remainingQty,
        location: locationArray,
      };
    } catch (error) {
      log.error("addToLinesArray-Error", error);
    }
  }

  function getSKUItemTable(item, skuTable) {
    try {
      // Use 'find' to get the matching record
      let matchedRecord = skuTable.find(
        (res) => res.values.custrecord_eig_orginal_sku_item[0].value == item
      );

      // Return the internal ID if a match is found, otherwise return null
      return matchedRecord ? matchedRecord.values.internalid[0].value : "";
    } catch (error) {
      log.error("getSKUItemTable-Error", error);
      return null; // Ensure a return value in case of an error
    }
  }

  function findNearestWarehouse(customerLat, customerLon, locationResult) {
    let nearestWarehouses = [];
    locationResult = JSON.parse(JSON.stringify(locationResult));

    for (let l = 0; l < locationResult.length; l++) {
      let result = locationResult[l];

      let locationLat = result.values["inventoryLocation.latitude"];
      let locationLon = result.values["inventoryLocation.longitude"];
      let locationName = result.values["inventorylocation"];

      const distance = EIG_Library_Function.calculateHaversine(
        customerLat,
        customerLon,
        locationLat,
        locationLon
      );
      if (distance != null) {
        nearestWarehouses.push({
          distance,
          result,
        });
      }
    }
    if (nearestWarehouses.length == 0) return;
    nearestWarehouses.sort((a, b) => a.distance - b.distance);

    return nearestWarehouses;
  }
  function itemSearchForSafetyStock(location, locationValues) {
    try {
      if (location.length > 0 && locationValues.length > 0) {
        var locationArr = location.map((res) => Number(res));
        // log.debug('locationArr', locationArr);
        // log.debug('locationValues', locationValues);
        return locationValues.filter((item) => {
          const itemLocationValue =
            item.getAllValues().inventorylocation[0].value;
          if (locationArr.includes(Number(itemLocationValue))) {
            return true;
          } else {
            return false;
          }
        });
      }
    } catch (error) {
      log.error("itemSearchForSafetyStock-Error", error.message);
    }
  }

  function logGovernanceUnit(stage) {
    const governanceUnit = runtime.getCurrentScript().getRemainingUsage();
    log.audit(`${stage} - Remaining Governance Unit`, governanceUnit);
  }
  function checkAssemblyItem(salesOrderRecord, i) {
    try {
      salesOrderRecord.selectLine("item", i);
      let isFailed = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "custcol_eig_is_failed_line",
      });
      // if (isFailed) {
      //   return;
      // }
      //if (isFailed) return;
      let itemType = salesOrderRecord.getCurrentSublistValue(
        "item",
        "itemtype",
        i
      );
      let itemText = salesOrderRecord.getCurrentSublistText("item", "item");
      log.debug("itemText", itemText);
      let getItemQuantity = salesOrderRecord.getCurrentSublistValue(
        "item",
        "quantity"
      );
      log.debug("getItemQuantity", getItemQuantity);
      let getItemRate = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "rate",
      });
      let kitName = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "custcol_kit_packagememo",
      });

      let isInvoiced = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "quantitybilled",
      });
      let getKitClass = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "class",
      });
      let kitDepartment = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "department",
      });
      let location = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "location",
      });
      let getCustomRate = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "custcol_eig_custom_rate",
      });
      const taxCode = salesOrderRecord.getCurrentSublistValue({
        sublistId: "item",
        fieldId: "taxcode",
      });
      if (itemType == "Assembly") {
        let isSplitItem = salesOrderRecord.getCurrentSublistValue(
          "item",
          "custcol_eig_is_split_item",
          i
        );
        if (isSplitItem == false && getItemQuantity > 0) {
          let item = salesOrderRecord.getCurrentSublistValue({
            sublistId: "item",
            fieldId: "item",
          });
          let isInvoiced = salesOrderRecord.getCurrentSublistValue({
            sublistId: "item",
            fieldId: "quantitybilled",
          });
          let getItemQuantity = salesOrderRecord.getCurrentSublistValue(
            "item",
            "quantity"
          );
          let rate = salesOrderRecord.getCurrentSublistValue("item", "rate");
          log.debug("item", item);
          let assemblyLookup = search.lookupFields({
            type: itemType == "Assembly" ? "assemblyitem" : "inventoryitem",
            id: item,
            columns: ["custitem_sellaspair"],
          });
          if (isInvoiced != 0) {
            salesOrderRecord.setCurrentSublistValue({
              sublistId: "item",
              fieldId: "quantity",
              value: 0,
            });
            salesOrderRecord.setCurrentSublistValue({
              sublistId: "item",
              fieldId: "location",
              value: "",
            });
            salesOrderRecord.setCurrentSublistValue({
              sublistId: "item",
              fieldId: "rate",
              value: 0,
            });
            salesOrderRecord.commitLine("item");
            getItemRate = rate / getItemQuantity;
            getItemRate = rate;
            isSellAsPair = assemblyLookup.custitem_sellaspair;
            log.debug("isSellAsPair", isSellAsPair);
            switch (isSellAsPair) {
              case true:
                log.debug("Invoice is not 0 Sell As Pair True");

                let pairedQuantity = Math.floor(getItemQuantity / 2);
                let remainingQuantity = getItemQuantity % 2;
                log.debug("Sell As Pair Of I", i);
                let paired = 1;
                for (paired; paired <= pairedQuantity; paired++) {
                  salesOrderRecord.insertLine({
                    sublistId: "item",
                    line: i + paired,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "item",
                    value: item,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_kit_packagememo",
                    value: kitName,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_sell_as_pair",
                    value: true,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "class",
                    value: getKitClass,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "location",
                    value: location,
                  });

                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "department",
                    value: kitDepartment,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "quantity",
                    value: 2,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "taxcode",
                    value: taxCode,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "rate",
                    value: Number(getItemRate),
                  });
                  salesOrderRecord.setCurrentSublistValue(
                    "item",
                    "custcol_eig_is_split_item",
                    true
                  );
                  salesOrderRecord.commitLine({
                    sublistId: "item",
                  });
                  i++;
                }
                if (remainingQuantity > 0) {
                  salesOrderRecord.insertLine({
                    sublistId: "item",
                    line: i + paired,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "item",
                    value: item,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_kit_packagememo",
                    value: kitName,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_sell_as_pair",
                    value: true,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "location",
                    value: location,
                  });

                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "class",
                    value: getKitClass,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "department",
                    value: kitDepartment,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "quantity",
                    value: remainingQuantity,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "rate",
                    value: Number(getItemRate),
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "taxcode",
                    value: taxCode,
                  });
                  salesOrderRecord.setCurrentSublistValue(
                    "item",
                    "custcol_eig_is_split_item",
                    true
                  );
                  salesOrderRecord.commitLine({
                    sublistId: "item",
                  });
                  i++;
                }
                break;

              case false:
                log.debug("Invoice is not 0 Sell As Pair False");

                for (let q = 1; q <= getItemQuantity; q++) {
                  log.debug("False OF I", i);
                  salesOrderRecord.insertLine({
                    sublistId: "item",
                    line: i + 1,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "item",
                    value: item,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "location",
                    value: location,
                  });

                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_kit_packagememo",
                    value: kitName,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "class",
                    value: getKitClass,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "department",
                    value: kitDepartment,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "quantity",
                    value: 1,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "taxcode",
                    value: taxCode,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "rate",
                    value: Number(getItemRate),
                  });
                  salesOrderRecord.setCurrentSublistValue(
                    "item",
                    "custcol_eig_is_split_item",
                    true
                  );
                  salesOrderRecord.commitLine({
                    sublistId: "item",
                  });
                  i++;
                }
                break;
            }
          } else {
            let removedLine = salesOrderRecord.removeLine("item", i); // Removed line logic
            log.debug("removedLine", removedLine);

            getItemRate = rate / getItemQuantity;
            getItemRate = rate;

            isSellAsPair = assemblyLookup.custitem_sellaspair;
            log.debug("isSellAsPair", isSellAsPair);
            switch (isSellAsPair) {
              case true:
                log.debug("Invoice is  0 Sell As Pair True");

                let pairedQuantity = Math.floor(getItemQuantity / 2);
                let remainingQuantity = getItemQuantity % 2;
                log.debug("Sell As Pair Of I", i);
                let paired = 0;
                for (paired; paired < pairedQuantity; paired++) {
                  salesOrderRecord.insertLine({
                    sublistId: "item",
                    line: i + paired,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "item",
                    value: item,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "location",
                    value: location,
                  });

                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_sell_as_pair",
                    value: true,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_kit_packagememo",
                    value: kitName,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "class",
                    value: getKitClass,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "department",
                    value: kitDepartment,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "quantity",
                    value: 2,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "taxcode",
                    value: taxCode,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "rate",
                    value: Number(getItemRate),
                  });
                  salesOrderRecord.setCurrentSublistValue(
                    "item",
                    "custcol_eig_is_split_item",
                    true
                  );
                  salesOrderRecord.commitLine({
                    sublistId: "item",
                  });
                }
                if (remainingQuantity > 0) {
                  salesOrderRecord.insertLine({
                    sublistId: "item",
                    line: i + paired,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "item",
                    value: item,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "location",
                    value: location,
                  });

                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_sell_as_pair",
                    value: true,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_kit_packagememo",
                    value: kitName,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "class",
                    value: getKitClass,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "department",
                    value: kitDepartment,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "quantity",
                    value: remainingQuantity,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "taxcode",
                    value: taxCode,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "rate",
                    value: Number(getItemRate),
                  });
                  salesOrderRecord.setCurrentSublistValue(
                    "item",
                    "custcol_eig_is_split_item",
                    true
                  );
                  salesOrderRecord.commitLine({
                    sublistId: "item",
                  });
                }
                break;

              case false:
                log.debug("Invoice is  0 Sell As Pair False");

                for (let q = 0; q < getItemQuantity; q++) {
                  log.debug("Sell As Pair False OF I", i);
                  salesOrderRecord.insertLine({
                    sublistId: "item",
                    line: i + q,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "item",
                    value: item,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "location",
                    value: location,
                  });

                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "custcol_kit_packagememo",
                    value: kitName,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "class",
                    value: getKitClass,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "department",
                    value: kitDepartment,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "quantity",
                    value: 1,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "taxcode",
                    value: taxCode,
                  });
                  salesOrderRecord.setCurrentSublistValue({
                    sublistId: "item",
                    fieldId: "rate",
                    value: Number(getItemRate),
                  });
                  salesOrderRecord.setCurrentSublistValue(
                    "item",
                    "custcol_eig_is_split_item",
                    true
                  );
                  salesOrderRecord.commitLine({
                    sublistId: "item",
                  });
                }
                break;
            }
          }
        }
      }
    } catch (error) {
      log.error("Check Assembly Item Error", error);
    }
  }
  return {
    getInputData: getInputData,
    map: map,
    reduce: reduce,
    summarize: summarize,
  };
});
